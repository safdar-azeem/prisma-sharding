import React from 'react';
import { createRoot } from 'react-dom/client';
import { StudioShellApp } from './studioShellApp';
import './studioShellStyles.css';

/**
 * Browser entry point for the Prisma Sharding Studio host.
 *
 * Bundled at package build time into `dist/studio-host-assets`, so starting
 * Studio never runs a bundler and never reaches the network. No configuration
 * is baked in: the shell asks the host which databases exist at runtime.
 */

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Studio host shell could not find its mount element.');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <StudioShellApp />
  </React.StrictMode>
);
