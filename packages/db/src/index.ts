import { PrismaClient } from '@prisma/client';

// One client per process. Prisma pools connections internally; constructing
// more than one exhausts Postgres connections under load.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

if (process.env['NODE_ENV'] !== 'production') globalForPrisma.prisma = prisma;
