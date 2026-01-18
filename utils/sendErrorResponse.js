const sendErrorResponse = (err, res) => {
    const statusCode = err.statusCode || 500;

    // Development: show full error
    if (process.env.NODE_ENV === "development") {
        return res.status(statusCode).json({
            success: false,
            error: err.message || "Server Error",
            // stack: err.stack,
            ...err,
        });
    }

    // Production: hide internals
    return res.status(statusCode).json({
        success: false,
        error: err.message || "Server Error",
    });
};

module.exports = sendErrorResponse;
