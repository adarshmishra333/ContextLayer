// server.js - ContextLayer Express.js Server
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { DatabaseService } = require('./db');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Environment variables validation
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SLACK_SIGNING_SECRET'
];

requiredEnvVars.forEach(envVar => {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
});

// Middleware to verify Slack requests
const verifySlackRequest = (req, res, next) => {
  try {
    const signature = req.headers['x-slack-signature'];
    const timestamp = req.headers['x-slack-request-timestamp'];
    
    if (!signature || !timestamp) {
      return res.status(400).json({ error: 'Missing Slack signature headers' });
    }

    // Check timestamp (prevent replay attacks)
    if (Math.abs(Date.now() / 1000 - timestamp) > 300) {
      return res.status(400).json({ error: 'Request timestamp too old' });
    }

    // Verify signature
    const body = req.rawBody || JSON.stringify(req.body);
    const sigBasestring = `v0:${timestamp}:${body}`;
    const mySignature = 'v0=' + crypto
      .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
      .update(sigBasestring)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature))) {
      return res.status(400).json({ error: 'Invalid request signature' });
    }

    next();
  } catch (error) {
    console.error('❌ Error fetching mapping details:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get failed mappings for retry
app.get('/api/failed-mappings', async (req, res) => {
  try {
    const maxRetries = parseInt(req.query.max_retries) || 3;
    const failedMappings = await DatabaseService.getFailedMappings(maxRetries);
    
    res.json({
      failed_mappings: failedMappings,
      count: failedMappings.length
    });
  } catch (error) {
    console.error('❌ Error fetching failed mappings:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Workspace management endpoints
app.post('/api/workspace', async (req, res) => {
  try {
    const workspace = await DatabaseService.upsertWorkspace(req.body);
    res.json(workspace);
  } catch (error) {
    console.error('❌ Error upserting workspace:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/workspaces', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('workspaces')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Error fetching workspaces:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Retry failed mapping endpoint
app.post('/api/mappings/:id/retry', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get the failed mapping
    const { data: mapping, error } = await supabase
      .from('slack_clickup_mappings')
      .select(`
        *,
        workspaces(*)
      `)
      .eq('id', id)
      .eq('sync_status', 'failed')
      .single();
    
    if (error) throw error;
    if (!mapping) {
      return res.status(404).json({ error: 'Failed mapping not found' });
    }
    
    // Reset status for retry
    await DatabaseService.updateSyncStatus(id, 'pending');
    
    // TODO: Trigger retry processing here
    // For now, just return success
    res.json({ 
      message: 'Mapping queued for retry',
      mapping_id: id 
    });
    
  } catch (error) {
    console.error('❌ Error retrying mapping:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Server startup
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Test database connection on startup
    console.log('🚀 Starting ContextLayer backend...');
    await DatabaseService.testConnection();
    
    app.listen(PORT, () => {
      console.log(`✅ ContextLayer backend running on port ${PORT}`);
      console.log(`🔗 Health check: http://localhost:${PORT}/health`);
      console.log(`📊 API docs: http://localhost:${PORT}/api/mappings`);
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

startServer();❌ Slack verification error:', error.message);
    res.status(400).json({ error: 'Invalid request' });
  }
};

// Middleware to capture raw body for signature verification
app.use('/slack/*', (req, res, next) => {
  let data = '';
  req.on('data', chunk => data += chunk);
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
});

// Slack API operations
class SlackService {
  static async getMessageDetails(token, channel, messageTs) {
    try {
      const response = await axios.get('https://slack.com/api/conversations.history', {
        headers: { 'Authorization': `Bearer ${token}` },
        params: {
          channel: channel,
          latest: messageTs,
          limit: 1,
          inclusive: true
        }
      });

      if (!response.data.ok) {
        throw new Error(`Slack API error: ${response.data.error}`);
      }

      return response.data.messages[0];
    } catch (error) {
      throw new Error(`Failed to fetch message: ${error.response?.data?.error || error.message}`);
    }
  }

  static async getThreadMessages(token, channel, threadTs) {
    try {
      const response = await axios.get('https://slack.com/api/conversations.replies', {
        headers: { 'Authorization': `Bearer ${token}` },
        params: {
          channel: channel,
          ts: threadTs
        }
      });

      if (!response.data.ok) {
        console.error('Slack thread fetch error:', response.data.error);
        return [];
      }

      return response.data.messages || [];
    } catch (error) {
      console.error('Failed to fetch thread:', error.message);
      return [];
    }
  }

  static async getUserInfo(token, userId) {
    try {
      const response = await axios.get('https://slack.com/api/users.info', {
        headers: { 'Authorization': `Bearer ${token}` },
        params: { user: userId }
      });

      if (!response.data.ok) {
        console.error('Slack user fetch error:', response.data.error);
        return null;
      }

      return response.data.user;
    } catch (error) {
      console.error('Failed to fetch user info:', error.message);
      return null;
    }
  }

  static async getChannelInfo(token, channelId) {
    try {
      const response = await axios.get('https://slack.com/api/conversations.info', {
        headers: { 'Authorization': `Bearer ${token}` },
        params: { channel: channelId }
      });

      if (!response.data.ok) {
        console.error('Slack channel fetch error:', response.data.error);
        return null;
      }

      return response.data.channel;
    } catch (error) {
      console.error('Failed to fetch channel info:', error.message);
      return null;
    }
  }
}

// ClickUp API operations
class ClickUpService {
  static async createTask(apiToken, listId, taskData) {
    try {
      const response = await axios.post(
        `https://api.clickup.com/api/v2/list/${listId}/task`,
        taskData,
        {
          headers: {
            'Authorization': apiToken,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data;
    } catch (error) {
      const errorMsg = error.response?.data?.err || error.response?.data?.error || error.message;
      throw new Error(`ClickUp API error: ${errorMsg}`);
    }
  }

  static formatSlackContextForClickUp(messageData, threadMessages = []) {
    const { message, user, channel, workspace } = messageData;
    
    let description = `**📝 Original Slack Message**\n\n`;
    description += `**From:** @${user?.display_name || user?.real_name || 'Unknown'}\n`;
    description += `**Channel:** #${channel?.name || 'Unknown'}\n`;
    description += `**When:** ${new Date(parseFloat(message.ts) * 1000).toLocaleString()}\n`;
    
    if (message.permalink) {
      description += `**Link:** ${message.permalink}\n\n`;
    }
    
    description += `**Message:**\n${message.text}\n\n`;

    // Add thread context if available
    if (threadMessages.length > 1) {
      description += `**🧵 Thread Context (${threadMessages.length - 1} replies):**\n\n`;
      threadMessages.slice(1).forEach((msg, i) => {
        description += `**Reply ${i + 1}** by @${msg.user_name || msg.user}:\n`;
        description += `${msg.text}\n\n`;
      });
    }

    description += `---\n*This task was created from Slack via ContextLayer*`;
    return description;
  }
}

// Main endpoint for Slack message actions
app.post('/slack/message-action', verifySlackRequest, async (req, res) => {
  try {
    // Parse Slack payload
    const payload = JSON.parse(req.body.payload);
    const { message, channel, user, team, response_url } = payload;

    console.log(`📨 Received message action from ${team.id}:${channel.id}:${message.ts}`);

    // Quick response to Slack
    res.status(200).json({
      text: "🔄 Creating ClickUp task with full Slack context...",
      response_type: "ephemeral"
    });

    // Process async
    processSlackMessage(payload, response_url).catch(error => {
      console.error('❌ Async processing error:', error.message);
    });

  } catch (error) {
    console.error('❌ Error processing message action:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function processSlackMessage(payload, responseUrl) {
  let mapping = null;

  try {
    const { message, channel, user, team } = payload;

    // Get workspace configuration
    const workspace = await DatabaseService.getWorkspace(team.id);
    if (!workspace) {
      throw new Error(`Workspace not configured for ${team.id}`);
    }

    console.log(`✅ Found workspace: ${workspace.slack_workspace_name}`);

    // Create initial mapping record
    mapping = await DatabaseService.createMapping({
      slack_message_id: message.ts,
      slack_channel_id: channel.id,
      slack_user_id: message.user,
      slack_workspace_id: team.id,
      slack_thread_ts: message.thread_ts || null,
      slack_message_text: message.text,
      slack_message_permalink: message.permalink || null,
      clickup_list_id: workspace.default_clickup_list_id,
      workspace_id: workspace.id
    });

    console.log(`✅ Created mapping: ${mapping.id}`);

    // Update status to processing
    await DatabaseService.updateSyncStatus(mapping.id, 'processing');

    // Fetch additional Slack context
    const [messageUser, channelInfo] = await Promise.all([
      SlackService.getUserInfo(workspace.slack_bot_token, message.user),
      SlackService.getChannelInfo(workspace.slack_bot_token, channel.id)
    ]);

    // Get thread context if it's a threaded message
    let threadMessages = [];
    if (message.thread_ts) {
      threadMessages = await SlackService.getThreadMessages(
        workspace.slack_bot_token,
        channel.id,
        message.thread_ts
      );
      console.log(`📝 Found ${threadMessages.length} thread messages`);
    }

    // Update mapping with enriched Slack data
    await DatabaseService.updateMapping(mapping.id, {
      slack_channel_name: channelInfo?.name,
      slack_user_name: messageUser?.display_name || messageUser?.real_name
    });

    // Create ClickUp task
    const taskDescription = ClickUpService.formatSlackContextForClickUp({
      message,
      user: messageUser,
      channel: channelInfo,
      workspace: team
    }, threadMessages);

    const taskData = {
      name: `Task from #${channelInfo?.name || 'slack'}: ${message.text.substring(0, 100)}${message.text.length > 100 ? '...' : ''}`,
      description: taskDescription,
      assignees: [],
      status: 'to do',
      priority: 3,
      tags: ['from-slack', 'contextlayer']
    };

    console.log(`🚀 Creating ClickUp task in list ${workspace.default_clickup_list_id}`);

    const clickupTask = await ClickUpService.createTask(
      workspace.clickup_api_token,
      workspace.default_clickup_list_id,
      taskData
    );

    console.log(`✅ Created ClickUp task: ${clickupTask.id}`);

    // Update mapping with ClickUp success
    await DatabaseService.updateSyncStatus(mapping.id, 'completed', {
      clickup_task_id: clickupTask.id,
      clickup_task_url: clickupTask.url,
      clickup_task_name: clickupTask.name
    });

    // Save thread context if available
    if (threadMessages.length > 0) {
      await DatabaseService.saveThreadContext(mapping.id, threadMessages);
    }

    // Send success response back to Slack
    await axios.post(responseUrl, {
      text: `✅ Task created successfully!`,
      attachments: [{
        color: 'good',
        title: 'ClickUp Task Created',
        title_link: clickupTask.url,
        text: `"${clickupTask.name}" with full Slack context`,
        fields: [
          { title: 'Task ID', value: clickupTask.id, short: true },
          { title: 'Status', value: 'To Do', short: true }
        ]
      }],
      response_type: 'ephemeral'
    });

    console.log(`🎉 Successfully processed mapping: ${mapping.id}`);

  } catch (error) {
    console.error('❌ Error processing Slack message:', error.message);

    // Update mapping with error if it exists
    if (mapping) {
      await DatabaseService.updateSyncStatus(mapping.id, 'failed', {
        error_message: error.message
      });
    }

    // Send error response back to Slack
    if (responseUrl) {
      try {
        await axios.post(responseUrl, {
          text: `❌ Failed to create task: ${error.message}`,
          response_type: 'ephemeral'
        });
      } catch (responseError) {
        console.error('❌ Failed to send error response to Slack:', responseError.message);
      }
    }
  }
}

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    await DatabaseService.testConnection();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected'
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

// API endpoints for dashboard
app.get('/api/mappings', async (req, res) => {
  try {
    const { limit, offset, workspace_id, sync_status } = req.query;
    
    const result = await DatabaseService.getMappings({
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
      workspace_id: workspace_id || null,
      sync_status: sync_status || null
    });
    
    res.json(result);
  } catch (error) {
    console.error('❌ Error fetching mappings:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/mappings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from('slack_clickup_mappings')
      .select(`
        *,
        workspaces(*),
        slack_thread_context(*)
      `)
      .eq('id', id)
      .single();
    
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Mapping not found' });
    
    res.json(data);
  } catch (error) {
    console.error('
