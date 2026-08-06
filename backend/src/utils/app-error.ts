/**
 * Expected business error thrown by protocol services. The routes translate it
 * into a 4xx response with a stable `code`; unexpected errors are passed to the
 * error middleware and returned as 500.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'AppError'
  }
}
