// An error that carries the HTTP status the server should answer with.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
module.exports = { HttpError };
