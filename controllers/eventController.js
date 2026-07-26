const mongoose = require('mongoose')
const Hackathon = require('../models/Hackathon')
const HackathonAnnouncement = require('../models/HackathonAnnouncement')
const HackathonStage = require('../models/HackathonStage')
const HackathonRegistration = require('../models/HackathonRegistration')
const HackathonSubmission = require('../models/HackathonSubmission')
const Notification = require('../models/Notification')
const { buildHackathonResults } = require('./adminHackathonController')

const publicEventQuery = { status: { $in: ['published', 'active', 'completed'] }, visibility: 'public' }
const publicUrl = (value) => (/^https?:\/\/\S+$/i.test(String(value || '').trim()) ? String(value).trim() : '')
const lookup = (idOrSlug) => mongoose.Types.ObjectId.isValid(String(idOrSlug || '')) ? { _id: idOrSlug } : { slug: String(idOrSlug || '').trim() }

const eventView = (event) => ({
  id: String(event._id),
  title: event.title,
  slug: event.slug || String(event._id),
  description: event.description || '',
  organizer: event.organizer || '',
  institute: event.institute || '',
  country: event.country || '',
  state: event.state || '',
  city: event.city || '',
  location: event.location || '',
  mode: event.mode || 'online',
  category: event.eventCategory || 'Hackathon',
  banner: publicUrl(event.bannerUrl),
  registrationUrl: publicUrl(event.registrationUrl),
  registrationButtonText: event.registrationButtonText || 'Register Now',
  registrationDeadline: event.registrationCloses || null,
  eventStart: event.startDate || null,
  eventEnd: event.endDate || null,
  teamSizeMin: event.teamSizeMin || null,
  teamSizeMax: event.teamSizeMax || null,
  prizes: event.prizes || [],
  brochure: event.brochureVisibility === 'public' ? (publicUrl(event.brochureUrl) || publicUrl(event.rules)) : '',
  brochureButtonText: event.brochureButtonText || 'Rules & Brochure',
  rules: publicUrl(event.rules) ? '' : event.rules || '',
  faqs: event.faqs || [],
  contactEmail: event.contactEmail || '',
  sponsors: event.sponsors || [],
  phase: event.phase,
  status: event.status,
  registrationOpen: event.phase === 'REGISTRATIONS_OPEN',
  published: true
})

exports.listEvents = async (_req, res) => {
  try {
    const events = await Hackathon.find(publicEventQuery).sort({ startDate: 1, createdAt: -1 }).lean()
    res.json({ events: events.map(eventView) })
  } catch (error) {
    console.error('List events error:', error)
    res.status(500).json({ message: 'Failed to load events' })
  }
}

exports.getEventDetails = async (req, res) => {
  try {
    const event = await Hackathon.findOne({ ...lookup(req.params.id), ...publicEventQuery }).lean()
    if (!event) return res.status(404).json({ message: 'Event not found' })
    const [announcements, stages] = await Promise.all([
      HackathonAnnouncement.find({ hackathon: event._id }).sort({ createdAt: -1 }).lean(),
      HackathonStage.find({ hackathon: event._id, visibility: { $ne: 'admin' } }).sort({ order: 1 }).lean()
    ])
    res.json({ event: eventView(event), announcements, stages })
  } catch (error) {
    console.error('Event detail error:', error)
    res.status(500).json({ message: 'Failed to load event' })
  }
}

exports.getEventDashboard = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?._id
    const isAdmin = req.user?.role === 'admin'
    const hackathon = await Hackathon.findOne({ ...lookup(req.params.id), ...(isAdmin ? {} : publicEventQuery) })
      .populate('activeStage', 'stageName description deadline instructions submissionRequired status visibility')
      .populate('judges', 'name')
      .populate('mentors', 'name')
      .populate('awards.project', 'title')
      .lean()
    if (!hackathon) return res.status(404).json({ message: 'Event not found' })
    if (!isAdmin && hackathon.phase === 'REGISTRATIONS_OPEN') return res.status(409).json({ message: 'The participant dashboard opens after registrations close.' })

    const registration = await HackathonRegistration.findOne({ hackathon: hackathon._id, registeredUsers: userId, registrationStatus: 'approved' })
      .populate({ path: 'project', select: 'title shortPitch category lifecycleStage owner teamMembers', populate: [{ path: 'owner', select: 'name email college', populate: { path: 'college', select: 'name' } }, { path: 'teamMembers', select: 'name email' }] })
      .populate('teamLead', 'name email')
      .populate('registeredUsers', 'name email')
      .populate('currentStage', 'stageName description deadline instructions submissionRequired status visibility')
      .lean()
    if (!registration && !isAdmin) return res.status(403).json({ message: 'Only approved event participants can access this dashboard.' })

    const [announcements, participantRegistrations, submission, stages, notifications] = await Promise.all([
      HackathonAnnouncement.find({ hackathon: hackathon._id }).sort({ createdAt: -1 }).lean(),
      HackathonRegistration.find({ hackathon: hackathon._id, registrationStatus: 'approved' })
        .populate({ path: 'project', select: 'title category lifecycleStage owner', populate: { path: 'owner', select: 'name college', populate: { path: 'college', select: 'name' } } })
        .populate('teamLead', 'name')
        .populate('currentStage', 'stageName')
        .sort({ createdAt: 1 }).lean(),
      registration ? HackathonSubmission.findOne({ hackathon: hackathon._id, registration: registration._id }).lean() : null,
      HackathonStage.find({ hackathon: hackathon._id, visibility: { $ne: 'admin' } }).sort({ order: 1 }).lean(),
      Notification.find({ recipient: userId, type: 'hackathon_announcement' }).sort({ createdAt: -1 }).limit(50).lean()
    ])
    const results = (isAdmin || ['public', 'participants'].includes(hackathon.leaderboardVisibility || 'participants'))
      ? await buildHackathonResults(hackathon._id)
      : null

    res.json({
      hackathon: {
        ...hackathon,
        brochureUrl: ['public', 'participants'].includes(hackathon.brochureVisibility || 'public') ? (publicUrl(hackathon.brochureUrl) || publicUrl(hackathon.rules)) : '',
        brochureButtonText: hackathon.brochureButtonText || 'Rules & Brochure'
      },
      registration,
      submission,
      announcements,
      notifications: notifications.filter((item) => String(item.actionUrl || '').includes(`/hackathons/${hackathon.slug || hackathon._id}/dashboard`)),
      stages,
      teams: participantRegistrations.map((item) => ({
        _id: item._id,
        teamName: item.teamName || item.project?.title || 'Event Team',
        projectName: item.project?.title || 'Project',
        college: item.project?.owner?.college?.name || '',
        currentRound: item.currentStage?.stageName || 'To be announced',
        status: item.roundStatus || 'active'
      })),
      leaderboard: (results?.rankings || []).map((row) => ({
        ...row,
        teamName: participantRegistrations.find((item) => String(item._id) === String(row.registrationId))?.teamName || row.project?.title || 'Event Team'
      }))
    })
  } catch (error) {
    console.error('Event dashboard error:', error)
    res.status(500).json({ message: 'Failed to load event dashboard' })
  }
}
