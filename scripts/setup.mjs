import { existsSync,copyFileSync } from 'node:fs';
if(existsSync('.env'))console.log('.env already exists; unchanged.');
else{copyFileSync('.env.example','.env');console.log('Created .env. Start the app and register your account in the browser.');}
