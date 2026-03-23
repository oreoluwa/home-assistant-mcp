#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { HAClient } from './ha-client.js';
import { tools } from './tools/index.js';
import { toolHandlers } from './handlers.js';

// Get configuration from environment
const HA_AGENT_URL = process.env.HA_AGENT_URL || 'http://homeassistant.local:8099';
const HA_AGENT_KEY = process.env.HA_AGENT_KEY;
const HA_INSTANCES: string[] = process.env.HA_INSTANCES
  ? JSON.parse(process.env.HA_INSTANCES)
  : ['main'];

if (!HA_AGENT_KEY) {
  // Always log errors - these are critical
  console.error('❌ Error: HA_AGENT_KEY environment variable is required');
  console.error('Please set it in Cursor: Settings → Tools & MCP → Add Custom MCP Server');
  console.error('Or manually in ~/.cursor/mcp.json');
  process.exit(1);
}

// Initialize HA client
const haClient = new HAClient({
  baseURL: HA_AGENT_URL,
  token: HA_AGENT_KEY,
});

// Create MCP server
const server = new Server(
  {
    name: 'home-assistant-mcp',
    version: '3.2.24',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// select_ha_instance tool definition
const selectInstanceTool = {
  name: 'select_ha_instance',
  description: 'Switch the active Home Assistant instance for this session. Call this before other tools to target a specific HA instance.',
  inputSchema: {
    type: 'object',
    properties: {
      instance: {
        type: 'string',
        enum: HA_INSTANCES,
        description: 'The HA instance name to activate',
      },
    },
    required: ['instance'],
  },
};

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: [selectInstanceTool, ...tools] };
});

// Register tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    return {
      content: [{ type: 'text', text: 'Error: No arguments provided' }],
      isError: true,
    };
  }

  try {
    // Built-in: switch active HA instance
    if (name === 'select_ha_instance') {
      const instance = (args as any).instance as string;
      if (!HA_INSTANCES.includes(instance)) {
        throw new Error(`Unknown instance: ${instance}. Available: ${HA_INSTANCES.join(', ')}`);
      }
      haClient.setInstance(instance);
      return { content: [{ type: 'text', text: `Switched to Home Assistant instance: ${instance}` }] };
    }

    // Look up handler from registry
    const handler = toolHandlers[name];
    
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    
    // Execute handler
    return await handler(haClient, args);
  } catch (error: any) {
    let errorMessage: string;
    
    // Handle axios errors
    if (error.response?.data) {
      const data = error.response.data;
      if (typeof data.detail === 'string') {
        errorMessage = data.detail;
      } else if (typeof data.detail === 'object') {
        errorMessage = JSON.stringify(data.detail, null, 2);
      } else if (typeof data === 'string') {
        errorMessage = data;
      } else if (typeof data === 'object') {
        errorMessage = JSON.stringify(data, null, 2);
      } else {
        errorMessage = String(data);
      }
    } else if (error.message) {
      errorMessage = error.message;
    } else if (typeof error === 'object') {
      errorMessage = JSON.stringify(error, null, 2);
    } else {
      errorMessage = String(error || 'Unknown error');
    }
    
    return {
      content: [{ type: 'text', text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  // Test connection on startup
  try {
    const health = await haClient.healthCheck();
    // Only log connection info if DEBUG mode is enabled (to avoid cluttering logs)
    // In production, connection is silent unless there's an error
    if (process.env.DEBUG === 'true') {
      console.error(`✅ Connected to HA Vibecode Agent v${health.version}`);
      console.error(`📁 Config path: ${health.config_path}`);
      console.error(`🔄 Git versioning auto: ${health.git_versioning_auto}`);
    }
  } catch (error: any) {
    // Always log errors - these are important
    console.error('❌ Failed to connect to HA Vibecode Agent');
    console.error(`URL: ${HA_AGENT_URL}`);
    console.error(`Error: ${error.message}`);
    console.error('\nPlease ensure:');
    console.error('1. HA Vibecode Agent add-on is running');
    console.error('2. HA_AGENT_URL is correct');
    console.error('3. HA_AGENT_KEY is valid');
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Only log startup message if DEBUG mode is enabled
  if (process.env.DEBUG === 'true') {
    console.error('🚀 MCP Home Assistant server running');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
