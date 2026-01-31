import { test, expect } from '@playwright/test';

test.describe('Stremio Addon - Basic Health Check', () => {
  
  test('should return valid manifest', async ({ request }) => {
    // Uses baseURL from playwright.config.ts (which loads from .env)
    const response = await request.get('/manifest.json');
    
    expect(response.ok()).toBeTruthy();
    expect(response.status()).toBe(200);
    
    const manifest = await response.json();
    
    // Print the manifest so you can see what it contains
    console.log('📦 Manifest:', JSON.stringify(manifest, null, 2));
    
    // Your first assertion
    expect(manifest).toHaveProperty('id');
    
    // 👇 ADD MORE ASSERTIONS HERE based on your manifest structure
  });
});
