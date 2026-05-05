const mongoose = require('mongoose');
const { Schema } = mongoose;

const AuditLogSchema = new mongoose.Schema(
  {
    client: { type: Schema.Types.ObjectId, ref: 'Client', index: true, default: null },
    branch: { type: Schema.Types.ObjectId, ref: 'Branch', index: true, default: null },

    case: {
      type: Schema.Types.ObjectId,
      ref: 'Case',
      required: [true, 'Case reference is required'],
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'Users',
      required: [true, 'User reference is required'],
    },
    action: {
      type: String,
      enum: [
        'case_created',
        'status_change',
        'assignment',
        'note_added',
        'field_update',
        'evidence_added',
        'alert_linked',
        'alert_unlinked',
        'sar_filed',
      ],
      required: [true, 'Action is required'],
    },
    details: { type: String, trim: true },
  },
  { timestamps: true }
);

AuditLogSchema.index({ case: 1, createdAt: -1 });
AuditLogSchema.index({ client: 1, branch: 1 });

module.exports = mongoose.model('AuditLog', AuditLogSchema);
