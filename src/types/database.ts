export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          error: string | null
          id: string
          input: Json
          result: Json | null
          started_at: string | null
          status: string
          type: string
          updated_at: string
          user_id: string
          worker_id: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          input?: Json
          result?: Json | null
          started_at?: string | null
          status?: string
          type: string
          updated_at?: string
          user_id: string
          worker_id?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          input?: Json
          result?: Json | null
          started_at?: string | null
          status?: string
          type?: string
          updated_at?: string
          user_id?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_jobs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      odin_learning_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          payload: Json
          source_id: string | null
          source_type: string
          status: string
          summary: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          payload?: Json
          source_id?: string | null
          source_type: string
          status?: string
          summary: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json
          source_id?: string | null
          source_type?: string
          status?: string
          summary?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "odin_learning_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      odin_memories: {
        Row: {
          confidence: number
          context_json: Json
          content: string
          created_at: string
          id: string
          kind: string
          source: string
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          confidence?: number
          context_json?: Json
          content: string
          created_at?: string
          id?: string
          kind?: string
          source?: string
          status?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          confidence?: number
          context_json?: Json
          content?: string
          created_at?: string
          id?: string
          kind?: string
          source?: string
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "odin_memories_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      odin_pending_items: {
        Row: {
          bucket: string
          business: string | null
          created_at: string
          due_at: string | null
          evidence_label: string | null
          evidence_url: string | null
          id: string
          last_seen_at: string
          next_action: string | null
          payload: Json
          person: string | null
          resolved_at: string | null
          source: string
          source_item_id: string
          status: string
          suggested_reply: string | null
          summary: string
          title: string
          updated_at: string
          urgency: string
          user_id: string
        }
        Insert: {
          bucket?: string
          business?: string | null
          created_at?: string
          due_at?: string | null
          evidence_label?: string | null
          evidence_url?: string | null
          id?: string
          last_seen_at?: string
          next_action?: string | null
          payload?: Json
          person?: string | null
          resolved_at?: string | null
          source: string
          source_item_id: string
          status?: string
          suggested_reply?: string | null
          summary?: string
          title: string
          updated_at?: string
          urgency?: string
          user_id: string
        }
        Update: {
          bucket?: string
          business?: string | null
          created_at?: string
          due_at?: string | null
          evidence_label?: string | null
          evidence_url?: string | null
          id?: string
          last_seen_at?: string
          next_action?: string | null
          payload?: Json
          person?: string | null
          resolved_at?: string | null
          source?: string
          source_item_id?: string
          status?: string
          suggested_reply?: string | null
          summary?: string
          title?: string
          updated_at?: string
          urgency?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "odin_pending_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      odin_scan_snapshots: {
        Row: {
          created_at: string
          id: string
          payload: Json
          scanned_at: string
          signal_count: number
          source: string
          status: string
          summary: string
          updated_at: string
          user_id: string
          warnings: string[]
          window_days: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          payload?: Json
          scanned_at?: string
          signal_count?: number
          source: string
          status?: string
          summary?: string
          updated_at?: string
          user_id: string
          warnings?: string[]
          window_days?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          payload?: Json
          scanned_at?: string
          signal_count?: number
          source?: string
          status?: string
          summary?: string
          updated_at?: string
          user_id?: string
          warnings?: string[]
          window_days?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "odin_scan_snapshots_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      auth_state: {
        Row: {
          account_label: string | null
          created_at: string
          provider: string
          redirect_to: string | null
          state: string
          user_id: string
        }
        Insert: {
          account_label?: string | null
          created_at?: string
          provider: string
          redirect_to?: string | null
          state: string
          user_id: string
        }
        Update: {
          account_label?: string | null
          created_at?: string
          provider?: string
          redirect_to?: string | null
          state?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "auth_state_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_events: {
        Row: {
          account_id: string | null
          attendees: Json
          calendar_id: string | null
          conference_url: string | null
          created_at: string
          description: string | null
          end_at: string
          event_id: string
          id: string
          is_all_day: boolean
          location: string | null
          organizer_email: string | null
          raw_metadata: Json
          recurrence: string[] | null
          start_at: string
          status: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          account_id?: string | null
          attendees?: Json
          calendar_id?: string | null
          conference_url?: string | null
          created_at?: string
          description?: string | null
          end_at: string
          event_id: string
          id?: string
          is_all_day?: boolean
          location?: string | null
          organizer_email?: string | null
          raw_metadata?: Json
          recurrence?: string[] | null
          start_at: string
          status?: string
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          account_id?: string | null
          attendees?: Json
          calendar_id?: string | null
          conference_url?: string | null
          created_at?: string
          description?: string | null
          end_at?: string
          event_id?: string
          id?: string
          is_all_day?: boolean
          location?: string | null
          organizer_email?: string | null
          raw_metadata?: Json
          recurrence?: string[] | null
          start_at?: string
          status?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_events_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "connected_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calendar_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          model: string | null
          role: string
          tokens_input: number | null
          tokens_output: number | null
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          model?: string | null
          role: string
          tokens_input?: number | null
          tokens_output?: number | null
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          model?: string | null
          role?: string
          tokens_input?: number | null
          tokens_output?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      connected_accounts: {
        Row: {
          access_token: string | null
          account_email: string | null
          account_label: string | null
          created_at: string
          id: string
          is_primary: boolean | null
          metadata: Json
          provider: string
          provider_account_id: string | null
          refresh_token: string | null
          scopes: string[] | null
          token_expires_at: string | null
          updated_at: string
          user_id: string
          workflow_rules: Json | null
          workspace_id: string | null
          workspace_name: string | null
        }
        Insert: {
          access_token?: string | null
          account_email?: string | null
          account_label?: string | null
          created_at?: string
          id?: string
          is_primary?: boolean | null
          metadata?: Json
          provider: string
          provider_account_id?: string | null
          refresh_token?: string | null
          scopes?: string[] | null
          token_expires_at?: string | null
          updated_at?: string
          user_id: string
          workflow_rules?: Json | null
          workspace_id?: string | null
          workspace_name?: string | null
        }
        Update: {
          access_token?: string | null
          account_email?: string | null
          account_label?: string | null
          created_at?: string
          id?: string
          is_primary?: boolean | null
          metadata?: Json
          provider?: string
          provider_account_id?: string | null
          refresh_token?: string | null
          scopes?: string[] | null
          token_expires_at?: string | null
          updated_at?: string
          user_id?: string
          workflow_rules?: Json | null
          workspace_id?: string | null
          workspace_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "connected_accounts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      emails: {
        Row: {
          account_id: string | null
          body_html: string | null
          body_text: string | null
          cc_addresses: string[] | null
          created_at: string
          from_address: string | null
          id: string
          is_archived: boolean
          is_read: boolean
          is_starred: boolean
          labels: string[] | null
          message_id: string
          raw_metadata: Json
          received_at: string | null
          snippet: string | null
          subject: string | null
          thread_id: string | null
          to_addresses: string[] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          account_id?: string | null
          body_html?: string | null
          body_text?: string | null
          cc_addresses?: string[] | null
          created_at?: string
          from_address?: string | null
          id?: string
          is_archived?: boolean
          is_read?: boolean
          is_starred?: boolean
          labels?: string[] | null
          message_id: string
          raw_metadata?: Json
          received_at?: string | null
          snippet?: string | null
          subject?: string | null
          thread_id?: string | null
          to_addresses?: string[] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          account_id?: string | null
          body_html?: string | null
          body_text?: string | null
          cc_addresses?: string[] | null
          created_at?: string
          from_address?: string | null
          id?: string
          is_archived?: boolean
          is_read?: boolean
          is_starred?: boolean
          labels?: string[] | null
          message_id?: string
          raw_metadata?: Json
          received_at?: string | null
          snippet?: string | null
          subject?: string | null
          thread_id?: string | null
          to_addresses?: string[] | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emails_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "connected_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emails_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      health_profiles: {
        Row: {
          active_plan: Json
          active_plan_selected_at: string | null
          context_summaries: Json
          created_at: string
          daily_steps: number
          diet_style: string
          focus: string
          notes: string
          protein_grams: number | null
          sleep_hours: number
          strength_days: number
          target_weight_kg: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          active_plan?: Json
          active_plan_selected_at?: string | null
          context_summaries?: Json
          created_at?: string
          daily_steps?: number
          diet_style?: string
          focus?: string
          notes?: string
          protein_grams?: number | null
          sleep_hours?: number
          strength_days?: number
          target_weight_kg?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          active_plan?: Json
          active_plan_selected_at?: string | null
          context_summaries?: Json
          created_at?: string
          daily_steps?: number
          diet_style?: string
          focus?: string
          notes?: string
          protein_grams?: number | null
          sleep_hours?: number
          strength_days?: number
          target_weight_kg?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "health_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      personal_routines: {
        Row: {
          actions: Json
          created_at: string
          cron_expression: string | null
          description: string | null
          id: string
          is_active: boolean
          last_run_at: string | null
          name: string
          next_run_at: string | null
          run_count: number
          trigger_config: Json
          trigger_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          actions?: Json
          created_at?: string
          cron_expression?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          name: string
          next_run_at?: string | null
          run_count?: number
          trigger_config?: Json
          trigger_type?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          actions?: Json
          created_at?: string
          cron_expression?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          name?: string
          next_run_at?: string | null
          run_count?: number
          trigger_config?: Json
          trigger_type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "personal_routines_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      priority_rules: {
        Row: {
          action_tags: string[] | null
          conditions: Json
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          notify: boolean
          priority_score: number
          sort_order: number
          source_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          action_tags?: string[] | null
          conditions?: Json
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          notify?: boolean
          priority_score?: number
          sort_order?: number
          source_type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          action_tags?: string[] | null
          conditions?: Json
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notify?: boolean
          priority_score?: number
          sort_order?: number
          source_type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "priority_rules_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      slack_messages: {
        Row: {
          account_id: string | null
          attachments: Json
          channel_id: string
          channel_name: string | null
          created_at: string
          id: string
          is_dm: boolean
          is_mention: boolean
          message_ts: string
          raw_metadata: Json
          reactions: Json
          sender_id: string | null
          sender_name: string | null
          sent_at: string | null
          text: string | null
          thread_ts: string | null
          updated_at: string
          user_id: string
          workspace_id: string
          workspace_name: string | null
        }
        Insert: {
          account_id?: string | null
          attachments?: Json
          channel_id: string
          channel_name?: string | null
          created_at?: string
          id?: string
          is_dm?: boolean
          is_mention?: boolean
          message_ts: string
          raw_metadata?: Json
          reactions?: Json
          sender_id?: string | null
          sender_name?: string | null
          sent_at?: string | null
          text?: string | null
          thread_ts?: string | null
          updated_at?: string
          user_id: string
          workspace_id: string
          workspace_name?: string | null
        }
        Update: {
          account_id?: string | null
          attachments?: Json
          channel_id?: string
          channel_name?: string | null
          created_at?: string
          id?: string
          is_dm?: boolean
          is_mention?: boolean
          message_ts?: string
          raw_metadata?: Json
          reactions?: Json
          sender_id?: string | null
          sender_name?: string | null
          sent_at?: string | null
          text?: string | null
          thread_ts?: string | null
          updated_at?: string
          user_id?: string
          workspace_id?: string
          workspace_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "slack_messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "connected_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slack_messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          preferences: Json
          timezone: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          preferences?: Json
          timezone?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          preferences?: Json
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
