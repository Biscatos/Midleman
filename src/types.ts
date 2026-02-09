/**
 * Application configuration interface
 */
export interface Config {
  port: number;
  targetUrl: string;
  authToken?: string; // Optional: if not set, authentication is disabled
}

/**
 * Custom error for unauthorized requests
 */
export class UnauthorizedError extends Error {
  constructor(message: string = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Custom error for configuration issues
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
