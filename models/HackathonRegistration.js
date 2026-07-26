const mongoose = require('mongoose')

const HackathonRegistrationSchema = new mongoose.Schema({
  hackathon: { type: mongoose.Schema.Types.ObjectId, ref: 'Hackathon', required: true, index: true },
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  registeredUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  teamName: { type: String, default: '', trim: true, maxlength: 180 },
  teamLead: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  currentStage: { type: mongoose.Schema.Types.ObjectId, ref: 'HackathonStage' },
  roundStatus: {
    type: String,
    enum: ['active', 'advanced', 'eliminated', 'disqualified', 'resubmission_requested'],
    default: 'active'
  },
  judgeAssignments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  mentorAssignments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  adminNotes: { type: String, default: '', trim: true, maxlength: 3000 },
  registrationStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'withdrawn'],
    default: 'pending',
    index: true
  },
  submittedAt: { type: Date, default: Date.now }
}, { timestamps: true })

HackathonRegistrationSchema.index({ hackathon: 1, project: 1 }, { unique: true })

module.exports = mongoose.model('HackathonRegistration', HackathonRegistrationSchema)
