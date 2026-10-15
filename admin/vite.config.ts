import { defineConfig } from 'vite';
export default defineConfig({base:'/admin/',server:{proxy:{'/api/admin':'http://localhost:3000'}}});
