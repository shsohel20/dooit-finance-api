// models/PolicyHub.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");

const { Schema } = mongoose;

const PolicyHubSchema = new Schema(
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
        docs: {
            type: String,
            // required: true,
            default: "", //rich Text
        },
        filePath: {
            type: String,
            // required: true,
            default: "", //rich Text
        },
        generatedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },

        metadata: { type: Schema.Types.Mixed, default: {} }, // createdBy, assignedTo, etc.

        // admin fields
        isActive: { type: Boolean, default: false },


    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    }
);

PolicyHubSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
PolicyHubSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("PolicyHub", PolicyHubSchema);
