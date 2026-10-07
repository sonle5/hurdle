// Messages are constructed by the migration runner, never from connection errors.
export class PostgresMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PostgresMigrationError";
    this.code = code;
  }
}
