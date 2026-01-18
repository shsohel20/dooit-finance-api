// models/Rule.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

const ClientRuleSchema = new Schema(
    {
        // Extra fields
        client: {
            type: Schema.Types.ObjectId,
            ref: 'Client',
            required: false,
            index: true,
        },
        branch: {
            type: Schema.Types.ObjectId,
            ref: 'Branch',
            required: false,
            index: true,
        },

        // From Excel
        ruleId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },

        ruleName: {
            type: String,
            required: true,
            trim: true,
        },

        ruleCondition: {
            type: String,
            required: true,
        },

        descriptiveExplanation: {
            type: String,
            default: '',
        },

        ruleDomainSubdomain: {
            type: String,
            trim: true,
        },

        mainDomain: {
            type: String,
            trim: true,
            index: true,
        },

        caseType: {
            type: String,
            enum: ['Fraud', 'AML', 'Compliance'],
            required: true,
        },

        riskScore: {
            type: Number,
            min: 0,
            max: 100,
            required: true,
        },

        riskLabel: {
            type: String,
            enum: ['Low', 'Medium', 'High'],
            required: true,
        },

        isActive: {
            type: Boolean,
            default: true,
            index: true,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model('ClientRule', ClientRuleSchema);
