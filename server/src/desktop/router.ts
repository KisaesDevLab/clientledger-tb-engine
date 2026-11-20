// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Every desktop-only route, under /api/v1 in desktop mode (app.ts). Kept
// apart from the spec (openapi.ts), so a test of the spec loads no route.

import { Router } from 'express';
import { buildOpenApiSpec } from './openapi';
import { desktopBackupRouter } from './backupRoutes';
import { desktopTbRouter } from './tbTotals';
import { desktopClientSummaryRouter } from './clientSummary';
import { desktopMeRouter } from './me';
import { desktopDraftRouter } from './draftStamp';
import { desktopAppSyncRouter } from './syncRoutes';

export const desktopRouter = Router();
desktopRouter.use(desktopBackupRouter);
desktopRouter.use(desktopTbRouter);
desktopRouter.use(desktopClientSummaryRouter);
desktopRouter.use(desktopMeRouter);
desktopRouter.use(desktopDraftRouter);
desktopRouter.use(desktopAppSyncRouter);
desktopRouter.get('/openapi.json', (_req, res) => {
  res.json(buildOpenApiSpec());
});
