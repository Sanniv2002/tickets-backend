import { db } from '../services/database.service'
import Ticket from '../models/tickets'
import EmailTemplates from '../models/emailTemplates'
import { ObjectId } from 'mongodb'
import Offers from '../models/offers'
import bcrypt from 'bcryptjs'

import { notificationQueue } from '../services/bullmq.service'

const getCollection = (
    collectionName:
        | 'tickets'
        | 'email_templates'
        | 'admins'
        | 'analytics'
        | 'offers'
        | 'notes'
        | 'notifications'
) => {
    if (!db) {
        throw new Error(
            'Database not initialized. Ensure `connectToDatabase()` is called before using `db`.'
        )
    }
    return db.collection(collectionName)
}

/**
 * Create a document in the `tickets` collection
 * @param data - The document data to insert
 * @returns The inserted document's ID
 */
export const createTicket = async (data: Ticket) => {
    try {
        const ticketsCollection = getCollection('tickets')
        const offersCollection = getCollection('offers')
        const activeOffer = await offersCollection.findOne({ active: true })
        if (activeOffer) {
            data.offerId = activeOffer._id
            data.price = activeOffer.price
        }
        const result = await ticketsCollection.insertOne(data)
        console.log('Ticket inserted with ID:', result.insertedId)
        return result.insertedId
    } catch (error) {
        console.error('Error creating ticket:', error)
        throw error
    }
}

/**
 * Update a document in the `tickets` collection
 * @param id - The ID of the document to update
 * @param updateData - The data to update
 * @returns The result of the update operation
 */
export const updateTicket = async (
    id: string,
    updateData: Record<string, any>
) => {
    try {
        const collection = getCollection('tickets')
        const filter = { _id: new ObjectId(id) }
        const updateDoc = { $set: updateData }
        const result = await collection.updateOne(filter, updateDoc)

        // Bit out of consistency in code here, notification worker is invoked here.
        const ticket = await collection.findOne<Ticket>(filter, { projection: { name: 1 } });
        const message = `${ticket?.name} has successfully purchased a ticket. 🎉`;
        await notificationQueue.add('notification', {
            _id: ticket?.id,
            message,
            ts: new Date(),
            read_by: [],
        })

        console.log(
            `Matched ${result.matchedCount} ticket(s), Modified ${result.modifiedCount} ticket(s)`
        )
        return result
    } catch (error) {
        console.error('Error updating ticket:', error)
        throw error
    }
}

/**
 * Get a document from the `tickets` collection by ID
 * @param id - The ID of the document to retrieve
 * @returns The ticket document, or null if not found
 */
export const getTicketById = async (id: string) => {
    try {
        const collection = getCollection('tickets')
        const filter = { _id: new ObjectId(id) }
        const ticket = await collection.findOne(filter)

        if (!ticket) {
            console.log(`Ticket with ID ${id} not found`)
            return null
        }
        return ticket
    } catch (error) {
        console.error('Error retrieving ticket:', error)
        throw error
    }
}

export const getAttendees = async (page: number, limit: number) => {
    try {
        const collection = getCollection('tickets')
        const filter = { ticket_given: true }

        const skip = (page - 1) * limit

        const tickets = await collection
            .find(filter)
            .skip(skip)
            .limit(limit)
            .toArray()

        const totalAttendees = tickets.length
        if (!tickets.length) {
            return []
        }

        return {
            total: totalAttendees,
            page,
            limit,
            tickets,
        }
    } catch (error) {
        console.error('Error retrieving attendees:', error)
        throw error
    }
}

/**
 * Perform a fuzzy search on the tickets collection
 * @param searchQuery - The query string to search for
 * @returns The search filter for MongoDB
 */
export const searchTickets = async (
    searchQuery: string,
    page: number,
    limit: number,
    filter: Record<string, any> = {}
) => {
    try {
        console.log(filter)
        const collection = getCollection('tickets')

        const skip = (page - 1) * limit

        // Pipeline for the search operation
        const pipeline = [
            {
                $search: {
                    text: {
                        query: searchQuery,
                        path: [
                            'stage',
                            'name',
                            'email',
                            'rollNumber',
                            'contactNumber',
                            'ticket_number',
                        ],
                        fuzzy: {},
                    },
                },
            },
            {
                $project: {
                    stage: 1,
                    name: 1,
                    email: 1,
                    rollNumber: 1,
                    contactNumber: 1,
                    degree: 1,
                    year: 1,
                    branch: 1,
                    createdAt: 1,
                    payment_proof: 1,
                    ticket_given: 1,
                    entry_marked: 1,
                    ticket_number: 1,
                    is_archived: 1,
                    score: { $meta: 'searchScore' },
                },
            },
            {
                $sort: { score: -1 },
            },
            {
                $skip: skip,
            },
            {
                $limit: limit,
            },
        ]

        let result = await collection.aggregate(pipeline).toArray()
        if (filter && Object.keys(filter).length > 0) {
            result = result.filter((ticket) => {
                return Object.entries(filter).every(([key, value]) => {
                    const expectedValue =
                        value === 'true'
                            ? true
                            : value === 'false'
                              ? false
                              : !isNaN(value as any)
                                ? Number(value)
                                : value

                    return ticket[key] === expectedValue
                })
            })
        }
        const total = result.length

        return {
            total,
            page,
            limit,
            tickets: result,
        }
    } catch (error) {
        console.error('Error searching tickets:', error)
        throw error
    }
}

/**
 * Get all tickets with pagination and fuzzy search functionality
 * @param page - The current page number
 * @param limit - The number of tickets per page
 * @param skip - The number of documents to skip for pagination
 * @returns The tickets matching the search query with pagination
 */
export const getAllTickets = async (
    page: number,
    limit: number,
    skip: number,
    filterObject: { [key: string]: string }
) => {
    try {
        const collection = getCollection('tickets')
        const isInvalidFilter =
            Object.keys(filterObject).length === 1 &&
            Object.keys(filterObject)[0] === '' &&
            filterObject[''] === ''
        const baseQuery = {
            $or: [{ is_archived: { $exists: false } }, { is_archived: false }],
        }
        const query = isInvalidFilter
            ? baseQuery
            : { $and: [baseQuery, filterObject] }
        let totalTickets
        totalTickets = await collection.countDocuments(query)
        const tickets = await collection
            .find(query)
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 })
            .toArray()

        return {
            total: totalTickets,
            page,
            limit,
            tickets,
        }
    } catch (error) {
        console.error('Error fetching paginated tickets:', error)
        throw error
    }
}

/**
 * Verify the payment for a specific ticket
 * @param ticketId - The ID of the ticket to verify payment for
 * @returns The updated ticket information
 */
export const verifyTicketPayment = async (ticketId: string) => {
    try {
        const collection = getCollection('tickets')

        const filter = { _id: new ObjectId(ticketId) }

        const ticket = await collection.findOne(filter)
        if (!ticket) {
            throw new Error(`Ticket with ID ${ticketId} not found`)
        }

        if (ticket.stage === '1' && !ticket.payment_proof) {
            throw new Error(
                'Payment proof is required to verify payment at stage 1'
            )
        }

        const updateDoc = { $set: { payment_verified: true } }

        const result = await collection.updateOne(filter, updateDoc)

        if (result.modifiedCount === 0) {
            throw new Error('Payment verification update failed')
        }

        const updatedTicket = await collection.findOne(filter)
        return updatedTicket
    } catch (error) {
        console.error('Error verifying payment:', error)
        throw error
    }
}

/**
 * Mark the ticket as given (delivered)
 * @param ticketId - The ID of the ticket to mark as given
 * @returns The updated ticket information
 */
export const markTicketAsGiven = async (
    ticketId: string,
    ticketNumber: string
) => {
    try {
        const collection = getCollection('tickets')

        const filter = { _id: new ObjectId(ticketId), payment_verified: true }

        const updateDoc = {
            $set: { ticket_given: true, ticket_number: ticketNumber },
        }

        const result = await collection.updateOne(filter, updateDoc)

        if (result.matchedCount === 0) {
            throw `Ticket payment is not verified`
        }

        const updatedTicket = await collection.findOne({
            _id: new ObjectId(ticketId),
        })
        return updatedTicket
    } catch (error) {
        console.error('Error marking ticket as given:', error)
        throw error
    }
}

export const toggleEntryMarked = async (ticketId: string) => {
    try {
        const collection = getCollection('tickets')

        // Find the current state of entry_marked
        const ticket = await collection.findOne({ _id: new ObjectId(ticketId) })

        if (!ticket) {
            throw new Error(`Ticket with ID ${ticketId} not found`)
        }

        const newEntryMarkedValue = !ticket.entry_marked // Toggle between true and false

        const updateDoc = {
            $set: { entry_marked: newEntryMarkedValue },
        }

        const result = await collection.updateOne(
            { _id: new ObjectId(ticketId) },
            updateDoc
        )

        if (result.matchedCount === 0) {
            throw new Error(`Ticket with ID ${ticketId} not found`)
        }

        const updatedTicket = await collection.findOne({
            _id: new ObjectId(ticketId),
        })
        return updatedTicket
    } catch (error) {
        console.error('Error toggling entry_marked:', error)
        throw error
    }
}

export const getFilteredTickets = async (filter: Record<string, any> = {}) => {
    try {
        const collection = getCollection('tickets')

        const tickets = await collection
            .find(filter)
            .sort({ createdAt: -1 })
            .toArray()

        return {
            total: tickets.length,
            tickets,
        }
    } catch (error) {
        console.error('Error fetching filtered tickets:', error)
        throw error
    }
}

export const getAllEmailTemplates = async () => {
    try {
        const collection = getCollection('email_templates')

        const templates = await collection.find({}).toArray()

        return {
            total: templates.length,
            templates,
        }
    } catch (error) {
        console.error('Error fetching email templates:', error)
        throw error
    }
}

export const getTicketsPaymentVerified = async (templateId: string) => {
    try {
        const collection = getCollection('tickets')

        const tickets = await collection
            .find({
                payment_verified: true,
                templatesSent: {
                    $not: {
                        $elemMatch: { templateId: new ObjectId(templateId) },
                    },
                },
            })
            .toArray()

        return tickets
    } catch (error) {
        console.error('Error fetching tickets marked as given:', error)
        throw error
    }
}

export const getEmailTemplateById = async (templateId: string) => {
    try {
        if (!ObjectId.isValid(templateId)) {
            throw new Error(`Invalid template ID: ${templateId}`)
        }

        const collection = getCollection('email_templates')

        const template = await collection.findOne({
            _id: new ObjectId(templateId),
        })

        if (!template) {
            throw new Error(`Email template with ID ${templateId} not found.`)
        }

        return new EmailTemplates(
            template.templateName,
            template.subject,
            template.body,
            template.thumbnail,
            template._id
        )
    } catch (error) {
        console.error(
            `Error fetching email template with ID ${templateId}:`,
            error
        )
        throw error
    }
}

export const updateEmailSentStatus = async (
    ticketId: string,
    templateId: string
) => {
    try {
        const collection = getCollection('tickets')

        const ticket = await collection.findOne({ _id: new ObjectId(ticketId) })

        if (!ticket) {
            throw new Error(`Ticket with ID ${ticketId} not found.`)
        }

        const updatedTemplatesSent = Array.isArray(ticket.templatesSent)
            ? [...ticket.templatesSent]
            : []

        updatedTemplatesSent.push({
            templateId: new ObjectId(templateId),
            sentAt: new Date(),
        })

        const result = await collection.updateOne(
            { _id: new ObjectId(ticketId) },
            {
                $set: {
                    last_email_sent_at: new Date(),
                    templatesSent: updatedTemplatesSent,
                },
            }
        )

        if (result.modifiedCount === 0) {
            throw new Error(`Ticket with ID ${ticketId} was not updated.`)
        }

        return result
    } catch (error) {
        console.error(
            `Error updating email sent status for ticket ${ticketId}:`,
            error
        )
        throw error
    }
}

export const findAdminByEmail = async (email: string) => {
    try {
        const collection = getCollection('admins')

        const admin = await collection.findOne(
            { email },
            { projection: { password: 1, email: 1, hasOnboarded: 1 } }
        )
        return admin
    } catch (error) {
        console.error('Error finding admin by email:', error)
        throw error
    }
}

export const findAdminById = async (id: string) => {
    try {
        const collection = getCollection('admins')

        const admin = await collection.findOne({ _id: new ObjectId(id) })
        return admin
    } catch (error) {
        console.error('Error finding admin by ID:', error)
        throw error
    }
}

const getTicketAnalytics = async () => {
    const collection = getCollection('tickets')
    const result = await collection
        .aggregate([
            {
                $match: {
                    $or: [
                        { is_archived: false },
                        { is_archived: { $exists: false } },
                    ],
                },
            },
            {
                $group: {
                    _id: null,
                    totalTickets: { $sum: 1 },
                    completedTicketsStage2: {
                        $sum: { $cond: [{ $eq: ['$stage', '2'] }, 1, 0] },
                    },
                    verifiedPayments: {
                        $sum: {
                            $cond: [{ $eq: ['$payment_verified', true] }, 1, 0],
                        },
                    },
                    entriesMarked: {
                        $sum: {
                            $cond: [{ $eq: ['$entry_marked', true] }, 1, 0],
                        },
                    },
                    totalRevenue: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ['$stage', '2'] },
                                        { $ne: ['$price', null] },
                                    ],
                                },
                                { $toDouble: '$price' },
                                0,
                            ],
                        },
                    },
                },
            },
            {
                $project: {
                    _id: 0,
                    totalTickets: 1,
                    completedTicketsStage2: 1,
                    verifiedPayments: 1,
                    entriesMarked: 1,
                    totalRevenue: 1,
                    timestamp: '$$NOW',
                },
            },
        ])
        .toArray()

    return result[0] || {}
}

export const saveAnalytics = async () => {
    const analyticsData = await getTicketAnalytics()
    if (!analyticsData || Object.keys(analyticsData).length === 0) {
        console.log('No data to insert.')
        return
    }

    const analyticsCollection = getCollection('analytics')
    await analyticsCollection.insertOne(analyticsData)
}

export const getLatestAnalytics = async () => {
    try {
        const analyticsCollection = getCollection('analytics')
        const latestAnalytics = await analyticsCollection
            .find()
            .sort({ _id: -1 })
            .limit(1)
            .toArray()

        if (latestAnalytics.length > 0) {
            return latestAnalytics[0]
        } else {
            console.log('No analytics data found.')
            return null
        }
    } catch (error) {
        console.error('Error fetching latest analytics data:', error)
        throw new Error('Failed to fetch latest analytics data')
    }
}

export const getAllOffers = async () => {
    const collection = getCollection('offers')
    try {
        const allOffers = await collection.find().toArray()
        return allOffers
    } catch (e) {
        console.log('Error:', e)
        return null
    }
}

export const getActiveOffer = async () => {
    const collection = getCollection('offers')
    try {
        return await collection.findOne({ active: true })
    } catch (e) {
        console.error('Error fetching active offer:', e)
        return null
    }
}

export const addOffer = async (offerData: Offers) => {
    const collection = getCollection('offers')
    try {
        const result = await collection.insertOne(offerData)
        return result.insertedId
    } catch (e) {
        console.log('Error adding offer:', e)
        return null
    }
}

export const updateActiveOffer = async (
    offerId: string,
    currentOfferId: string
) => {
    const collection = getCollection('offers')
    try {
        // Set the current active offer to false if it exists
        if (currentOfferId) {
            await collection.updateOne(
                { _id: new ObjectId(currentOfferId) },
                { $set: { active: false } }
            )
        }

        // Activate the new offer
        const result = await collection.updateOne(
            { _id: new ObjectId(offerId) },
            { $set: { active: true } }
        )

        return result.modifiedCount > 0
    } catch (e) {
        console.error('Error updating active offer:', e)
        return false
    }
}

export const deleteOffer = async (offerId: string) => {
    const collection = getCollection('offers')
    try {
        const result = await collection.deleteOne({
            _id: new ObjectId(offerId),
        })
        return result.deletedCount > 0
    } catch (e) {
        console.error('Error deleting offer:', e)
        return false
    }
}

export const getAllAdmins = async () => {
    const collection = getCollection('admins')

    try {
        const admins = await collection
            .find(
                {},
                {
                    projection: {
                        email: 1,
                        isSuperAdmin: 1,
                        hasOnboarded: 1,
                        _id: 0,
                    },
                }
            )
            .toArray()

        return admins
    } catch (e) {
        console.error('Error fetching admins:', e)
        return []
    }
}

export const addAdmin = async (email: string, password: string) => {
    const collection = getCollection('admins')

    try {
        const existingAdmin = await collection.findOne({ email })
        if (existingAdmin) {
            return { success: false, message: 'Admin already exists' }
        }

        const hashedPassword = await bcrypt.hash(password, 10)

        const result = await collection.insertOne({
            email,
            password: hashedPassword,
            isSuperAdmin: false,
            hasOnboarded: false,
        })

        return { success: true, adminId: result.insertedId }
    } catch (error) {
        console.log(error)
        return { success: false, message: 'Internal server error' }
    }
}

export const resetPassword = async (id: string, newPassword: string) => {
    const collection = getCollection('admins')
    try {
        const admin = await collection.findOne({ _id: new ObjectId(id) })
        if (!admin) {
            return { success: false, message: 'No admin exists' }
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10)

        if (hashedPassword === admin.password) {
            return {
                success: false,
                message: 'New password and previous cannot be same',
            }
        }
        await collection.updateOne(
            { _id: new ObjectId(id) },
            {
                $set: {
                    password: hashedPassword,
                    hasOnboarded: true,
                },
            }
        )
        return { success: true }
    } catch (error) {
        return { success: false, message: error }
    }
}

export const getAllNotes = async () => {
    const collection = getCollection('notes')

    try {
        const notes = await collection.find().toArray()

        return { success: true, notes }
    } catch (error) {
        console.error(error)
        return { success: false, message: 'Internal server error' }
    }
}

export const addNote = async (
    heading: string,
    items: { description: string; toggle?: boolean; tags?: string[] }[],
    author: string,
    createdBy: string
) => {
    const collection = getCollection('notes')

    try {
        const result = await collection.insertOne({
            heading,
            items,
            author,
            createdBy: new ObjectId(createdBy),
            createdAt: new Date(),
            updatedAt: new Date(),
            isArchived: false,
        })

        return { success: true, noteId: result.insertedId }
    } catch (error) {
        console.error(error)
        return { success: false, message: 'Internal server error' }
    }
}

export const deleteNote = async (noteId: string) => {
    const collection = getCollection('notes')

    try {
        const result = await collection.deleteOne({ _id: new ObjectId(noteId) })

        if (result.deletedCount === 0) {
            return { success: false, message: 'Note not found' }
        }

        return { success: true, message: 'Note deleted successfully' }
    } catch (error) {
        console.error(error)
        return { success: false, message: 'Internal server error' }
    }
}

export const updateNote = async (
    noteId: string,
    updates: Partial<{ heading: string; items: any[]; isArchived: boolean }>
) => {
    try {
        const collection = getCollection('notes')

        if (!ObjectId.isValid(noteId)) {
            return { success: false, message: 'Invalid note ID' }
        }

        const result = await collection.updateOne(
            { _id: new ObjectId(noteId) },
            {
                $set: {
                    ...updates,
                    updatedAt: new Date(),
                },
            }
        )

        if (result.matchedCount === 0) {
            return { success: false, message: 'Note not found' }
        }

        return { success: true, message: 'Note updated successfully' }
    } catch (error) {
        console.error(error)
        return { success: false, message: 'Internal server error' }
    }
}

export const toggleArchive = async (id: string) => {
    if (!ObjectId.isValid(id)) {
        throw new Error('Invalid ticket ID')
    }

    const collection = getCollection('tickets')

    const ticket = await collection.findOne({ _id: new ObjectId(id) })

    if (!ticket) {
        throw new Error('Ticket not found')
    }

    const newArchiveStatus = !ticket.is_archived

    const result = await collection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { is_archived: newArchiveStatus } }
    )

    if (result.modifiedCount === 0) {
        throw new Error('Failed to update ticket')
    }

    return {
        message: `Ticket ${newArchiveStatus ? 'archived' : 'unarchived'} successfully`,
        is_archived: newArchiveStatus,
    }
}

export const getArchivedTickets = async (page: number, limit: number) => {
    const collection = getCollection('tickets')

    const skip = (page - 1) * limit

    const totalArchivedTickets = await collection.countDocuments({
        is_archived: true,
    })

    const tickets = await collection
        .find({ is_archived: true })
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .toArray()

    return {
        total: totalArchivedTickets,
        page,
        limit,
        tickets,
    }
}

export const addNotification = async (message: string, ts: Date) => {
    const notificationCollection = getCollection('notifications')
    try {
        const result = await notificationCollection.insertOne({
            message,
            ts: new Date(ts),
            read_by: []
        })

        return { success: true, notifId: result.insertedId }
    } catch (error) {
        console.error(error)
        return { success: false, message: 'Internal server error' }
    }
}

export const getNotifications = async (
    userId: string,
    page: number,
    limit: number
) => {
    try {
        const collection = getCollection("notifications");
        const skip = (page - 1) * limit;
        const userObjectId = new ObjectId(userId);

        const notifications = await collection
            .aggregate([
                {
                    $addFields: {
                        read: {
                            $cond: {
                                if: { $in: [userObjectId, "$read_by"] },
                                then: true,
                                else: false
                            }
                        }
                    }
                },
                { $sort: { ts: -1 } },
                { $skip: skip },
                { $limit: limit }
            ])
            .toArray();

        const total = await collection.countDocuments();

        return {
            total,
            page,
            limit,
            notifications
        };
    } catch (error) {
        console.error("Error fetching notifications:", error);
        throw new Error("Failed to fetch notifications");
    }
};

export const markNotificationsAsRead = async (
    userId: string,
    notificationIds: string[]
) => {
    try {
        const collection = getCollection("notifications");
        const userObjectId = new ObjectId(userId);

        const objectIds = notificationIds.map((id) => new ObjectId(id));

        const result = await collection.updateMany(
            {
                _id: { $in: objectIds },
                read_by: { $ne: userObjectId }
            },
            {
                $addToSet: { read_by: userObjectId }
            }
        );

        return {
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount
        };
    } catch (error) {
        console.error("Error marking notifications as read:", error);
        throw new Error("Failed to update notifications");
    }
};
