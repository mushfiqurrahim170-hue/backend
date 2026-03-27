#!/bin/bash
# Quick fix for TypeScript build errors on server
# Run this script on your server to fix the TS2307 module resolution errors

echo "========================================"
echo "TypeScript Build Fix - Server Script"
echo "========================================"
echo ""

cd /root/lovable-export-7fe76f25/backend || { echo "Error: Cannot access backend directory"; exit 1; }

echo "Step 1: Creating types directory..."
mkdir -p src/types

echo "Step 2: Creating modules.d.ts file..."
cat > src/types/modules.d.ts << 'EOF'
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
EOF

echo "✓ modules.d.ts created"

echo "Step 3: Updating tsconfig.json..."
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true
  },
  "include": ["src/**/*.ts"]
}
EOF

echo "✓ tsconfig.json updated"

echo "Step 4: Cleaning and rebuilding..."
rm -rf dist
npm install
npm run build

if [ $? -eq 0 ]; then
    echo ""
    echo "========================================"
    echo "✅ BUILD SUCCESSFUL!"
    echo "========================================"
else
    echo ""
    echo "========================================"
    echo "❌ BUILD FAILED"
    echo "========================================"
    echo ""
    echo "Please check the error messages above."
    echo "If files were not created correctly, try:"
    echo "  cat src/types/modules.d.ts"
    echo "  cat tsconfig.json"
fi

echo ""
echo "Fix applied. Check SERVER_FIX_GUIDE.md for more details."
