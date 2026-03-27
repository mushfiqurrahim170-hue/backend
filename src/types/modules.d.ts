declare module '../db/postgres.js' {
  export const pool: any;
  export function initPostgres(): Promise<void>;
  export function closePostgres(): Promise<void>;
  export function isPostgresConfigured(): boolean;
}

declare module '../lib/encryption.js' {
  export function encrypt(text: string): string;
  export function decrypt(encryptedText: string): string;
  export function encryptApiKey(apiKey: string): string;
  export function decryptApiKey(encryptedKey: string): string;
  export function hashValue(value: string): string;
}

declare module '../middleware/validation.js' {
  import { Request, Response, NextFunction } from 'express';
  export function isValidEmail(email: string): boolean;
  export function isStrongPassword(password: string): boolean;
  export function validateRegistration(req: Request, res: Response, next: NextFunction): void;
  export function validateLogin(req: Request, res: Response, next: NextFunction): void;
  export function validateApiKeySave(req: Request, res: Response, next: NextFunction): void;
  export function validateStrategyCreate(req: Request, res: Response, next: NextFunction): void;
  export function validateTradeExecution(req: Request, res: Response, next: NextFunction): void;
  export function validateDeposit(req: Request, res: Response, next: NextFunction): void;
}
