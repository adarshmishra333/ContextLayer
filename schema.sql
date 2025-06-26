-- ContextLayer Database Schema
-- PostgreSQL/Supabase compatible

-- Workspaces table to store Slack workspace configurations
CREATE TABLE workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slack_workspace_id VARCHAR(255) UNIQUE NOT NULL,
    slack_workspace_name VARCHAR(255),
    slack_bot_token TEXT, -- encrypted bot token
    clickup_api_token TEXT, -- encrypted ClickUp token
    clickup_team_id VARCHAR(255),
    default_clickup_list_id VARCHAR(255), -- fallback list
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Main table for Slack <-> ClickUp mappings
CREATE TABLE slack_clickup_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Slack context
    slack_message_id VARCHAR(255) NOT NULL,
    slack_channel_id VARCHAR(255) NOT NULL,
    slack_user_id VARCHAR(255) NOT NULL,
    slack_workspace_id VARCHAR(255) NOT NULL,
    slack_thread_ts VARCHAR(255), -- null if not a thread message
    slack_message_text TEXT NOT NULL,
    slack_message_permalink TEXT, -- Slack's permanent link to message
    slack_channel_name VARCHAR(255),
    slack_user_name VARCHAR(255),
    
    -- ClickUp context
    clickup_task_id VARCHAR(255),
    clickup_list_id VARCHAR(255) NOT NULL,
    clickup_task_url TEXT,
    clickup_task_name VARCHAR(500),
    
    -- Processing status
    sync_status VARCHAR(50) DEFAULT 'pending' CHECK (sync_status IN ('pending', 'processing', 'completed', 'failed')),
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Foreign key
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    
    -- Ensure no duplicate mappings
    UNIQUE(slack_message_id, slack_workspace_id)
);

-- Index for fast lookups
CREATE INDEX idx_slack_clickup_workspace ON slack_clickup_mappings(slack_workspace_id);
CREATE INDEX idx_slack_clickup_status ON slack_clickup_mappings(sync_status);
CREATE INDEX idx_slack_clickup_created ON slack_clickup_mappings(created_at DESC);

-- Optional: Store thread context for richer task descriptions
CREATE TABLE slack_thread_context (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mapping_id UUID REFERENCES slack_clickup_mappings(id) ON DELETE CASCADE,
    thread_message_id VARCHAR(255) NOT NULL,
    thread_user_id VARCHAR(255) NOT NULL,
    thread_user_name VARCHAR(255),
    thread_message_text TEXT NOT NULL,
    thread_timestamp VARCHAR(255) NOT NULL,
    message_order INTEGER, -- order within thread
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_workspaces_updated_at BEFORE UPDATE ON workspaces 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    
CREATE TRIGGER update_mappings_updated_at BEFORE UPDATE ON slack_clickup_mappings 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
