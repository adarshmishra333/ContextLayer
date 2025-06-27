// ContextLayer Express.js Backend
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const rawBodyBuffer = (req, res, buf, encoding) => {
  req.rawBody = buf.toString(encoding || 'utf8');
};

app.use(express.json({ verify: rawBodyBuffer }));

app.use(express.urlencoded({ extended: true }));

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware to verify Slack requests
const verifySlackRequest = (req, res, next) => {
  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];
  const body = JSON.stringify(req.body);
  
  // Check timestamp (prevent replay attacks)
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) {
    return res.status(400).send('Request too old');
  }
  
  // Verify signature
  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(sigBasestring)
    .digest('hex');
  
  if (crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature))) {
    next();
  } else {
    res.status(400).send('Invalid signature');
  }
};

// Database operations
class DatabaseService {
  static async getWorkspace(slackWorkspaceId) {
    const { data, error } = await supabase
      .from('workspaces')
      .select('*')
      .eq('slack_workspace_id', slackWorkspaceId)
      .eq('is_active', true)
      .single();
    
    if (error) throw error;
    return data;
  }
  
  static async createMapping(mappingData) {
    const { data, error } = await supabase
      .from('slack_clickup_mappings')
      .insert(mappingData)
      .select()
      .single();
    
    if (error) throw error;
    return data;
  }
  
  static async updateMapping(id, updates) {
    const { data, error } = await supabase
      .from('slack_clickup_mappings')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    return data;
  }
  
  static async saveThreadContext(mappingId, threadMessages) {
    if (!threadMessages || threadMessages.length === 0) return;
    
    const threadData = threadMessages.map((msg, index) => ({
      mapping_id: mappingId,
      thread_message_id: msg.ts,
      thread_user_id: msg.user,
      thread_user_name: msg.user_name || msg.user,
      thread_message_text: msg.text,
      thread_timestamp: msg.ts,
      message_order: index
    }));
    
    const { error } = await supabase
      .from('slack_thread_context')
      .insert(threadData);
    
    if (error) throw error;
  }
}

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
      
      return response.data.messages[0];
    } catch (error) {
      throw new Error(`Failed to fetch message: ${error.message}`);
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
      throw new Error(`ClickUp API error: ${error.response?.data?.err || error.message}`);
    }
  }
  
  static formatSlackContextForClickUp(messageData, threadMessages = []) {
    const { message, user, channel, workspace } = messageData;
    
    let description = `**📝 Original Slack Message**\n\n`;
    description += `**From:** @${user?.display_name || user?.real_name || 'Unknown'}\n`;
    description += `**Channel:** #${channel?.name || 'Unknown'}\n`;
    description += `**When:** ${new Date(parseFloat(message.ts) * 1000).toLocaleString()}\n`;
    description += `**Link:** ${message.permalink}\n\n`;
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
    
    // Quick response to Slack
    res.status(200).json({
      text: "🔄 Creating ClickUp task with full context...",
      response_type: "ephemeral"
    });
    
    // Process async
    processSlackMessage(payload, response_url).catch(console.error);
    
  } catch (error) {
    console.error('Error processing message action:', error);
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
      throw new Error('Workspace not configured');
    }
    
    // Create initial mapping record
    mapping = await DatabaseService.createMapping({
      slack_message_id: message.ts,
      slack_channel_id: channel.id,
      slack_user_id: message.user,
      slack_workspace_id: team.id,
      slack_thread_ts: message.thread_ts || null,
      slack_message_text: message.text,
      slack_message_permalink: message.permalink,
      clickup_list_id: workspace.default_clickup_list_id,
      workspace_id: workspace.id,
      sync_status: 'processing'
    });
    
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
    }
    
    // Create ClickUp task
    const taskDescription = ClickUpService.formatSlackContextForClickUp({
      message,
      user: messageUser,
      channel: channelInfo,
      workspace: team
    }, threadMessages);
    
    const taskData = {
      name: `Task from #${channelInfo?.name || 'slack'}: ${message.text.substring(0, 100)}...`,
      description: taskDescription,
      assignees: [], // Could map Slack users to ClickUp users
      status: 'to do',
      priority: 3,
      due_date: null,
      tags: ['from-slack', 'contextlayer']
    };
    
    const clickupTask = await ClickUpService.createTask(
      workspace.clickup_api_token,
      workspace.default_clickup_list_id,
      taskData
    );
    
    // Update mapping with ClickUp details
    await DatabaseService.updateMapping(mapping.id, {
      clickup_task_id: clickupTask.id,
      clickup_task_url: clickupTask.url,
      clickup_task_name: clickupTask.name,
      slack_channel_name: channelInfo?.name,
      slack_user_name: messageUser?.display_name || messageUser?.real_name,
      sync_status: 'completed'
    });
    
    // Save thread context
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
          { title: 'List', value: workspace.default_clickup_list_id, short: true }
        ]
      }],
      response_type: 'ephemeral'
    });
    
  } catch (error) {
    console.error('Error processing Slack message:', error);
    
    // Update mapping with error
    if (mapping) {
      await DatabaseService.updateMapping(mapping.id, {
        sync_status: 'failed',
        error_message: error.message,
        retry_count: (mapping.retry_count || 0) + 1
      });
    }
    
    // Send error response back to Slack
    if (responseUrl) {
      await axios.post(responseUrl, {
        text: `❌ Failed to create task: ${error.message}`,
        response_type: 'ephemeral'
      });
    }
  }
}

// Health check endpoint
// Health check endpoint (with Supabase DB check)
app.get('/health', async (req, res) => {
  try {
    const { error } = await supabase
      .from('slack_clickup_mappings')
      .select('*')
      .limit(1);

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: error ? 'disconnected' : 'connected'
    });
  } catch (err) {
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: err.message
    });
  }
});


// Get mapping history (for dashboard)
app.get('/api/mappings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('slack_clickup_mappings')
      .select(`
        *,
        slack_thread_context(*)
      `)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ContextLayer backend running on port ${PORT}`);
});
