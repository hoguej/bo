#!/usr/bin/env bun
/**
 * Set up Railway services programmatically via GraphQL API
 * 
 * Usage: bun run scripts/setup-railway.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Load .env.local manually
try {
  const envPath = join(process.cwd(), '.env.local');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    }
  }
} catch (error) {
  console.warn('⚠️  Could not load .env.local');
}

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';
const RAILWAY_TOKEN = process.env.RAILWAY_PERSONAL_KEY || process.env.RAILWAY_KEY;

if (!RAILWAY_TOKEN) {
  console.error('❌ RAILWAY_PERSONAL_KEY not set in .env.local');
  console.error('Add: RAILWAY_PERSONAL_KEY=your-personal-token-here');
  process.exit(1);
}

async function railwayQuery(query: string, variables: Record<string, any> = {}) {
  const response = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RAILWAY_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();
  
  if (result.errors) {
    console.error('GraphQL Errors:', JSON.stringify(result.errors, null, 2));
    throw new Error('Railway API error');
  }

  return result.data;
}

async function setupRailway() {
  console.log('🚂 Setting up Railway services...\n');

  try {
    // Get user info
    const meQuery = `query { me { id email name } }`;
    const meData = await railwayQuery(meQuery);
    console.log(`✓ Authenticated as: ${meData.me.name} (${meData.me.email})\n`);

    // List projects
    const projectsQuery = `query { projects { edges { node { id name } } } }`;
    const projectsData = await railwayQuery(projectsQuery);
    const projects = projectsData.projects.edges;

    console.log('📁 Your projects:');
    for (const { node } of projects) {
      console.log(`   • ${node.name} (${node.id})`);
    }
    console.log();

    // Check if Bo project exists
    const boProject = projects.find((p: any) => p.node.name.toLowerCase().includes('bo'));
    
    if (!boProject) {
      console.log('❌ No Bo project found. Please create one in Railway dashboard first.\n');
      process.exit(1);
    }

    const projectId = boProject.node.id;
    console.log(`✓ Using project: ${boProject.node.name}`);
    console.log(`  Project ID: ${projectId}\n`);
    
    // List existing services
    const servicesQuery = `
      query($projectId: String!) {
        project(id: $projectId) {
          services {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;
    
    const servicesData = await railwayQuery(servicesQuery, { projectId });
    const existingServices = servicesData.project.services.edges.map((e: any) => e.node);
    
    console.log('🔧 Existing services:');
    for (const service of existingServices) {
      console.log(`   • ${service.name} (${service.id})`);
    }
    console.log();

    // Check which services we need to create
    const hasPostgres = existingServices.some((s: any) => s.name.toLowerCase().includes('postgres'));
    const hasRedis = existingServices.some((s: any) => s.name.toLowerCase().includes('redis'));
    
    console.log('📦 Creating missing services...\n');

    // Create PostgreSQL if missing
    if (!hasPostgres) {
      console.log('Creating PostgreSQL service...');
      const createPostgres = `
        mutation($projectId: String!) {
          templateDeploy(input: {
            projectId: $projectId
            template: "postgresql"
          }) {
            id
          }
        }
      `;
      
      try {
        await railwayQuery(createPostgres, { projectId });
        console.log('✓ PostgreSQL service created\n');
      } catch (error) {
        console.log('⚠️  Could not create PostgreSQL via API. Please add manually in Railway dashboard.\n');
      }
    } else {
      console.log('✓ PostgreSQL already exists\n');
    }

    // Create Redis if missing
    if (!hasRedis) {
      console.log('Creating Redis service...');
      const createRedis = `
        mutation($projectId: String!) {
          templateDeploy(input: {
            projectId: $projectId
            template: "redis"
          }) {
            id
          }
        }
      `;
      
      try {
        await railwayQuery(createRedis, { projectId });
        console.log('✓ Redis service created\n');
      } catch (error) {
        console.log('⚠️  Could not create Redis via API. Please add manually in Railway dashboard.\n');
      }
    } else {
      console.log('✓ Redis already exists\n');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✨ Railway setup complete!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log('📋 Next steps:');
    console.log('   1. Add 2 GitHub repo services in Railway dashboard:');
    console.log('      • "bo-web" - Next.js portal');
    console.log('      • "bo-daemon" - Telegram bot daemon');
    console.log('   2. Configure environment variables (see .env.production.example)');
    console.log('   3. Run database migration');
    console.log('   4. Deploy!\n');

  } catch (error) {
    console.error('❌ Setup failed:', error);
    process.exit(1);
  }
}

setupRailway();
