const QRCode = require("qrcode");

/**
 * Generate QR Code for Client or Branch
 *
 * @param {Object} params
 * @param {String} params.clientId (required)
 * @param {String} [params.branchId]
 * @param {String} [params.format] - base64 | png | svg
 * @param {Boolean} [params.useUrl] - encode URL instead of JSON
 */
const generateQR = async ({
    clientId,
    branchId = null,
    format = "base64",
    useUrl = true,
}) => {
    // ============================
    // Validation
    // ============================

    if (!clientId) {
        throw new Error("clientId is required");
    }

    // ============================
    // Payload Builder
    // ============================

    let payload;

    if (useUrl) {
        // Recommended approach (production safe)
        const baseUrl = process.env.CLIENT_INVITE_URL;

        payload = branchId
            ? `${baseUrl}/scan-qr?client=${clientId}&branch=${branchId}`
            : `${baseUrl}/scan-qr?client=${clientId}`;
    } else {
        // Raw JSON payload (not recommended for production)
        payload = JSON.stringify({
            type: branchId ? "BRANCH" : "CLIENT",
            branchId,
            clientId,
            ts: Date.now(),
        });
    }



    const qrOptions = {
        errorCorrectionLevel: "H",
        width: 300,
        margin: 2,
    };

    // ============================
    // Format Handling
    // ============================

    switch (format) {
        case "svg":
            return await QRCode.toString(payload, {
                ...qrOptions,
                type: "svg",
            });

        case "png":
            return await QRCode.toBuffer(payload, {
                ...qrOptions,
                type: "png",
            });

        case "base64":
        default:
            return await QRCode.toDataURL(payload, qrOptions);
    }
};

/**
 * Generate a QR code for an arbitrary, already-built URL (e.g. a SOF
 * verification upload link). Unlike generateQR(), the caller owns the full
 * payload — this just renders it.
 *
 * @param {String} url
 * @param {String} [format] - base64 | png | svg
 */
const generateQRFromUrl = async (url, format = "base64") => {
  if (!url) throw new Error("url is required");

  const qrOptions = {
    errorCorrectionLevel: "H",
    width: 300,
    margin: 2,
  };

  switch (format) {
    case "svg":
      return await QRCode.toString(url, { ...qrOptions, type: "svg" });
    case "png":
      return await QRCode.toBuffer(url, { ...qrOptions, type: "png" });
    case "base64":
    default:
      return await QRCode.toDataURL(url, qrOptions);
  }
};

module.exports = { generateQR, generateQRFromUrl };