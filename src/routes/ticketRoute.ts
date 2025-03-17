import express, { Request } from "express";
import { z } from "zod";
import multer from "multer";
import { formDetails } from "../utils/validationSchemas";
import { logger } from "../services/logger.service";
import { createTicket, getActiveOffer } from "../utils/dbUtils";
import { addFileUploadToQueue } from "../services/fileUpload.service";
import { invalidateTicketCache } from "../services/cache.service";

export const ticketsRouter = express.Router();
ticketsRouter.use(express.json());

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/jpg",
  "application/pdf",
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(
        new Error("Invalid file type. Only images and PDFs are allowed.")
      );
    }
    cb(null, true);
  },
});

ticketsRouter.post("/save-progress", async (req: Request, res: any) => {
  try {
    const payload = formDetails.parse(req.body);

    const data = {
      ...payload,
      branch:
        payload.branch === "Other" && payload.branchOther
          ? payload.branchOther
          : payload.branch,
      year:
        payload.year === "Other" && payload.yearOther
          ? payload.yearOther
          : payload.year,
    };

    // Remove unnecessary fields
    delete data.branchOther;
    delete data.yearOther;

    logger.info(
      `Received request to save progress at stage 1 with data: ${JSON.stringify(
        data
      )}`
    );

    const createdTicket = await createTicket({
      stage: "1",
      ...data,
      createdAt: new Date(),
      payment_verified: false,
      ticket_given: false,
    });
    // await invalidateTicketCache()
    logger.info(`Ticket created successfully with ID: ${createdTicket.id}`);

    res.status(200).json({ id: createdTicket, message: `Success at stage 1` });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      logger.error(`Validation error: ${JSON.stringify(e.errors)}`);
      return res.status(400).json({ message: "Invalid data" });
    } else {
      logger.error(`Unexpected error: ${e.message}`);
      return res.status(500).json({ message: "An unexpected error occurred" });
    }
  }
});

ticketsRouter.post(
  "/finalize",
  upload.single("file"),
  async (req: Request, res: any) => {
    try {
      const { id } = req.body;

      if (!id) {
        return res.status(400).json({ message: "ID is required" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const { mimetype, buffer, size } = req.file;

      if (!ALLOWED_MIME_TYPES.includes(mimetype)) {
        return res.status(400).json({
          message: "Invalid file type. Only images and PDFs are allowed.",
        });
      }

      if (size > MAX_FILE_SIZE) {
        return res.status(400).json({
          message: `File size exceeds the limit of ${
            MAX_FILE_SIZE / (1024 * 1024)
          } MB.`,
        });
      }

      const fileName = `payment_proof_${id}`;
      await addFileUploadToQueue(id, buffer, fileName, mimetype);

      logger.info(`File upload job added to queue for ID: ${id}`);
      await invalidateTicketCache()
      res.status(200).json({ message: "File upload queued successfully", id });
    } catch (error: any) {
      logger.error(`Error during file upload: ${error.message}`);
      res.status(500).json({
        message: "File upload or queueing failed",
        error: error.message,
      });
    }
  }
);

ticketsRouter.get("/offers/current", async (_, res: any) => {
  try {
    const activeOffer = await getActiveOffer();
    
    if (!activeOffer) {
      return res.status(404).json({ message: "No active offer found" });
    }

    res.status(200).json(activeOffer);
  } catch (e) {
    console.error("Error fetching current offer:", e);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default ticketsRouter;
