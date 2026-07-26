const mongoose = require('mongoose')

const HackathonSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 180 },
  slug: { type: String, trim: true, lowercase: true, maxlength: 180, sparse: true, index: true },
  description: { type: String, default: '', trim: true, maxlength: 5000 },
  organizer: { type: String, default: '', trim: true, maxlength: 180 },
  institute: { type: String, default: '', trim: true, maxlength: 240 },
  country: { type: String, default: '', trim: true, maxlength: 120 },
  state: { type: String, default: '', trim: true, maxlength: 120 },
  city: { type: String, default: '', trim: true, maxlength: 120 },
  eventCategory: { type: String, default: 'Hackathon', trim: true, maxlength: 120 },
  bannerUrl: { type: String, default: '', trim: true, maxlength: 1000 },
  logoUrl: { type: String, default: '', trim: true, maxlength: 1000 },
  theme: { type: String, default: '', trim: true, maxlength: 300 },
  location: { type: String, default: '', trim: true, maxlength: 300 },
  mode: { type: String, enum: ['online', 'offline', 'hybrid'], default: 'online' },
  startDate: { type: Date },
  endDate: { type: Date },
  rules: { type: String, default: '', trim: true, maxlength: 8000 },
  brochureUrl: { type: String, default: '', trim: true, maxlength: 1000 },
  brochureButtonText: { type: String, default: 'Rules & Brochure', trim: true, maxlength: 80 },
  brochureVisibility: { type: String, enum: ['public', 'participants', 'admin'], default: 'public' },
  eligibility: { type: String, default: '', trim: true, maxlength: 3000 },
  themes: [{ type: String, trim: true, maxlength: 120 }],
  prizes: [{ type: String, trim: true, maxlength: 180 }],
  sponsors: [{ type: String, trim: true, maxlength: 180 }],
  judges: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  mentors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  faqs: [{ question: { type: String, trim: true, maxlength: 500 }, answer: { type: String, trim: true, maxlength: 3000 } }],
  registrationUrl: { type: String, default: '', trim: true, maxlength: 1000 },
  registrationButtonText: { type: String, default: 'Register Now', trim: true, maxlength: 80 },
  registrationOpens: { type: Date },
  registrationCloses: { type: Date },
  teamSizeMin: { type: Number, min: 1, max: 50 },
  teamSizeMax: { type: Number, min: 1, max: 50 },
  contactEmail: { type: String, default: '', trim: true, maxlength: 320 },
  activeStage: { type: mongoose.Schema.Types.ObjectId, ref: 'HackathonStage' },
  externalEventUrl: { type: String, default: '', trim: true, maxlength: 1000 },
  completionButtonText: { type: String, default: 'View Event Results', trim: true, maxlength: 100 },
  completionVisibility: { type: String, enum: ['public', 'participants', 'admin'], default: 'public' },
  leaderboardVisibility: { type: String, enum: ['hidden', 'public', 'participants', 'admin'], default: 'participants' },
  awards: [{
    title: { type: String, required: true, trim: true, maxlength: 180 },
    registration: { type: mongoose.Schema.Types.ObjectId, ref: 'HackathonRegistration' },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    note: { type: String, default: '', trim: true, maxlength: 1000 }
  }],
  status: {
    type: String,
    enum: ['draft', 'published', 'active', 'completed', 'archived'],
    default: 'draft',
    index: true
  },
  visibility: {
    type: String,
    enum: ['private', 'college', 'public'],
    default: 'private',
    index: true
  },
  phase: {
    type: String,
    enum: ['REGISTRATIONS_OPEN', 'REGISTRATIONS_CLOSED', 'HACKATHON_OPEN', 'HACKATHON_CLOSED'],
    default: 'REGISTRATIONS_OPEN',
    index: true
  },
  archivedAt: { type: Date },
  archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true })

HackathonSchema.index({ startDate: 1, status: 1 })

module.exports = mongoose.model('Hackathon', HackathonSchema)
