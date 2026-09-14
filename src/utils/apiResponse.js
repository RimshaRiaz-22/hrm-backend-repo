/** Standard API envelope: error, message, data */
function sendSuccess(res, statusCode, message, data = null) {
  return res.status(statusCode).json({
    error: false,
    message,
    data,
  });
}

function sendError(res, statusCode, message, data = null) {
  return res.status(statusCode).json({
    error: true,
    message,
    data,
  });
}

module.exports = {
  sendSuccess,
  sendError,
};
