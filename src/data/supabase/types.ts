export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      app_config: {
        Row: {
          is_public: boolean
          key: string
          updated_at: string
          value: NonNullable<Json>
        }
        ComputedFields: never
        Insert: {
          is_public?: boolean
          key: string
          updated_at?: string
          value: NonNullable<Json>
        }
        Update: {
          is_public?: boolean
          key?: string
          updated_at?: string
          value?: NonNullable<Json>
        }
        Relationships: []
      }
      blocks: {
        Row: {
          blocked_id: string
          blocker_id: string
          created_at: string
        }
        ComputedFields: never
        Insert: {
          blocked_id: string
          blocker_id: string
          created_at?: string
        }
        Update: {
          blocked_id?: string
          blocker_id?: string
          created_at?: string
        }
        Relationships: []
      }
      challenge_templates: {
        Row: {
          description: string
          id: string
          sort_order: number
          target: number
          title: string
        }
        ComputedFields: never
        Insert: {
          description: string
          id: string
          sort_order: number
          target: number
          title: string
        }
        Update: {
          description?: string
          id?: string
          sort_order?: number
          target?: number
          title?: string
        }
        Relationships: []
      }
      consents: {
        Row: {
          created_at: string
          id: string
          kind: string
          user_id: string
          version: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          kind: string
          user_id: string
          version: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          user_id?: string
          version?: string
        }
        Relationships: []
      }
      devices: {
        Row: {
          created_at: string
          device_id: string
          last_seen_at: string
          live_activity_drive: string | null
          live_activity_leg: number | null
          live_activity_sent_at: string | null
          live_activity_token: string | null
          platform: string
          push_token: string | null
          updated_at: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          device_id: string
          last_seen_at?: string
          live_activity_drive?: string | null
          live_activity_leg?: number | null
          live_activity_sent_at?: string | null
          live_activity_token?: string | null
          platform: string
          push_token?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          device_id?: string
          last_seen_at?: string
          live_activity_drive?: string | null
          live_activity_leg?: number | null
          live_activity_sent_at?: string | null
          live_activity_token?: string | null
          platform?: string
          push_token?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      event_disputes: {
        Row: {
          client_event_id: string
          created_at: string
          reason: string
          status: string
          trip_id: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          client_event_id: string
          created_at?: string
          reason: string
          status: string
          trip_id: string
          user_id: string
        }
        Update: {
          client_event_id?: string
          created_at?: string
          reason?: string
          status?: string
          trip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_disputes_event_fkey"
            columns: ["trip_id", "client_event_id"]
            isOneToOne: true
            referencedRelation: "trip_events"
            referencedColumns: ["trip_id", "client_event_id"]
          },
        ]
      }
      friend_requests: {
        Row: {
          created_at: string
          from_id: string
          to_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          from_id: string
          to_id: string
        }
        Update: {
          created_at?: string
          from_id?: string
          to_id?: string
        }
        Relationships: []
      }
      friendships: {
        Row: {
          created_at: string
          user_a: string
          user_b: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          user_a: string
          user_b: string
        }
        Update: {
          created_at?: string
          user_a?: string
          user_b?: string
        }
        Relationships: []
      }
      global_rate_limits: {
        Row: {
          count: number
          created_at: string
          key: string
          updated_at: string
          window_start: string
        }
        ComputedFields: never
        Insert: {
          count?: number
          created_at?: string
          key: string
          updated_at?: string
          window_start?: string
        }
        Update: {
          count?: number
          created_at?: string
          key?: string
          updated_at?: string
          window_start?: string
        }
        Relationships: []
      }
      inbox: {
        Row: {
          created_at: string
          dedupe_key: string
          id: string
          kind: string
          payload: NonNullable<Json>
          push_after: string
          push_attempts: number
          push_claimed_at: string | null
          push_reason: string | null
          push_state: string
          pushed_at: string | null
          updated_at: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          dedupe_key: string
          id?: string
          kind: string
          payload?: NonNullable<Json>
          push_after?: string
          push_attempts?: number
          push_claimed_at?: string | null
          push_reason?: string | null
          push_state?: string
          pushed_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          dedupe_key?: string
          id?: string
          kind?: string
          payload?: NonNullable<Json>
          push_after?: string
          push_attempts?: number
          push_claimed_at?: string | null
          push_reason?: string | null
          push_state?: string
          pushed_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      limits_cache: {
        Row: {
          created_at: string
          expires_at: string
          geom: unknown
          heading_deg: number | null
          limit_mph: number
          provider: string
          segment_key: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          expires_at: string
          geom: unknown
          heading_deg?: number | null
          limit_mph: number
          provider?: string
          segment_key: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          geom?: unknown
          heading_deg?: number | null
          limit_mph?: number
          provider?: string
          segment_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      map_feedback: {
        Row: {
          created_at: string
          id: string
          lat: number
          limit_mph: number | null
          lng: number
          speed_mph: number | null
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          lat: number
          limit_mph?: number | null
          lng: number
          speed_mph?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          lat?: number
          limit_mph?: number | null
          lng?: number
          speed_mph?: number | null
        }
        Relationships: []
      }
      notification_prefs: {
        Row: {
          created_at: string
          leagues: boolean
          quiet_enabled: boolean
          quiet_end: string
          quiet_start: string
          social: boolean
          tz: string | null
          updated_at: string
          user_id: string
          weekly_recap: boolean
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          leagues?: boolean
          quiet_enabled?: boolean
          quiet_end?: string
          quiet_start?: string
          social?: boolean
          tz?: string | null
          updated_at?: string
          user_id: string
          weekly_recap?: boolean
        }
        Update: {
          created_at?: string
          leagues?: boolean
          quiet_enabled?: boolean
          quiet_end?: string
          quiet_start?: string
          social?: boolean
          tz?: string | null
          updated_at?: string
          user_id?: string
          weekly_recap?: boolean
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          flagged: boolean
          heatmap_visibility: string
          id: string
          league_eligible: boolean
          onboarded_at: string | null
          share_achievements: boolean
          share_categories: boolean
          share_rating: boolean
          share_stats: boolean
          state: string | null
          units: string
          updated_at: string
          username: string | null
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          flagged?: boolean
          heatmap_visibility?: string
          id: string
          league_eligible?: boolean
          onboarded_at?: string | null
          share_achievements?: boolean
          share_categories?: boolean
          share_rating?: boolean
          share_stats?: boolean
          state?: string | null
          units?: string
          updated_at?: string
          username?: string | null
        }
        Update: {
          created_at?: string
          flagged?: boolean
          heatmap_visibility?: string
          id?: string
          league_eligible?: boolean
          onboarded_at?: string | null
          share_achievements?: boolean
          share_categories?: boolean
          share_rating?: boolean
          share_stats?: boolean
          state?: string | null
          units?: string
          updated_at?: string
          username?: string | null
        }
        Relationships: []
      }
      progress: {
        Row: {
          created_at: string
          miles_90d: number
          ranked: boolean
          rating_updated_at: string | null
          rating_week_ago: number | null
          safety_rating: number | null
          updated_at: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          miles_90d?: number
          ranked?: boolean
          rating_updated_at?: string | null
          rating_week_ago?: number | null
          safety_rating?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          miles_90d?: number
          ranked?: boolean
          rating_updated_at?: string | null
          rating_week_ago?: number | null
          safety_rating?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      push_deliveries: {
        Row: {
          created_at: string
          error: string | null
          id: string
          inbox_id: string
          receipt_checked_at: string | null
          receipt_error: string | null
          receipt_status: string | null
          ticket_id: string | null
          token: string | null
          updated_at: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          error?: string | null
          id?: string
          inbox_id: string
          receipt_checked_at?: string | null
          receipt_error?: string | null
          receipt_status?: string | null
          ticket_id?: string | null
          token?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          error?: string | null
          id?: string
          inbox_id?: string
          receipt_checked_at?: string | null
          receipt_error?: string | null
          receipt_status?: string | null
          ticket_id?: string | null
          token?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_deliveries_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inbox"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limits: {
        Row: {
          count: number
          created_at: string
          key: string
          updated_at: string
          user_id: string
          window_start: string
        }
        ComputedFields: never
        Insert: {
          count?: number
          created_at?: string
          key: string
          updated_at?: string
          user_id: string
          window_start?: string
        }
        Update: {
          count?: number
          created_at?: string
          key?: string
          updated_at?: string
          user_id?: string
          window_start?: string
        }
        Relationships: []
      }
      reports: {
        Row: {
          created_at: string
          id: string
          note: string
          reason: string
          reporter_id: string
          target_id: string
          target_kind: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          note?: string
          reason: string
          reporter_id: string
          target_id: string
          target_kind: string
        }
        Update: {
          created_at?: string
          id?: string
          note?: string
          reason?: string
          reporter_id?: string
          target_id?: string
          target_kind?: string
        }
        Relationships: []
      }
      route_pool: {
        Row: {
          id: string
          polyline: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          id?: string
          polyline: string
          user_id: string
        }
        Update: {
          id?: string
          polyline?: string
          user_id?: string
        }
        Relationships: []
      }
      trip_events: {
        Row: {
          client_event_id: string
          created_at: string
          duration_s: number
          lat: number | null
          lng: number | null
          measured: NonNullable<Json>
          started_at: string
          status: string
          tier: string
          trip_id: string
          type: string
          updated_at: string
          user_id: string
          zone: string | null
        }
        ComputedFields: never
        Insert: {
          client_event_id: string
          created_at?: string
          duration_s: number
          lat?: number | null
          lng?: number | null
          measured?: NonNullable<Json>
          started_at: string
          status?: string
          tier: string
          trip_id: string
          type: string
          updated_at?: string
          user_id: string
          zone?: string | null
        }
        Update: {
          client_event_id?: string
          created_at?: string
          duration_s?: number
          lat?: number | null
          lng?: number | null
          measured?: NonNullable<Json>
          started_at?: string
          status?: string
          tier?: string
          trip_id?: string
          type?: string
          updated_at?: string
          user_id?: string
          zone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trip_events_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trips: {
        Row: {
          app_version: string | null
          archived_at: string | null
          clean: boolean
          client_trip_id: string
          created_at: string
          dashcam_covered_s: number
          dashcam_device_id: string | null
          dashcam_moving_s: number
          dashcam_on: boolean
          dashcam_synced: boolean
          duration_s: number
          ended_at: string
          id: string
          league_week: string
          limit_s: number
          local_day: string
          miles: number
          moving_s: number
          n_dashcam: number
          n_events: number
          n_hard_accel: number
          n_hard_brake: number
          n_hard_corner: number
          n_speeding: number
          night_miles: number
          not_driving: boolean
          not_driving_at: string | null
          not_driving_expired: boolean
          origin: string
          phone_s: number
          polyline: string
          reason: string | null
          result: Json | null
          scored: boolean
          scoring_version: number
          slowdowns: number
          speedups: number
          started_at: string
          turns: number
          tz: string
          updated_at: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          app_version?: string | null
          archived_at?: string | null
          clean?: boolean
          client_trip_id: string
          created_at?: string
          dashcam_covered_s?: number
          dashcam_device_id?: string | null
          dashcam_moving_s?: number
          dashcam_on?: boolean
          dashcam_synced?: boolean
          duration_s: number
          ended_at: string
          id?: string
          league_week: string
          limit_s: number
          local_day: string
          miles: number
          moving_s: number
          n_dashcam?: number
          n_events?: number
          n_hard_accel?: number
          n_hard_brake?: number
          n_hard_corner?: number
          n_speeding?: number
          night_miles: number
          not_driving?: boolean
          not_driving_at?: string | null
          not_driving_expired?: boolean
          origin?: string
          phone_s?: number
          polyline?: string
          reason?: string | null
          result?: Json | null
          scored?: boolean
          scoring_version?: number
          slowdowns: number
          speedups: number
          started_at: string
          turns: number
          tz: string
          updated_at?: string
          user_id: string
        }
        Update: {
          app_version?: string | null
          archived_at?: string | null
          clean?: boolean
          client_trip_id?: string
          created_at?: string
          dashcam_covered_s?: number
          dashcam_device_id?: string | null
          dashcam_moving_s?: number
          dashcam_on?: boolean
          dashcam_synced?: boolean
          duration_s?: number
          ended_at?: string
          id?: string
          league_week?: string
          limit_s?: number
          local_day?: string
          miles?: number
          moving_s?: number
          n_dashcam?: number
          n_events?: number
          n_hard_accel?: number
          n_hard_brake?: number
          n_hard_corner?: number
          n_speeding?: number
          night_miles?: number
          not_driving?: boolean
          not_driving_at?: string | null
          not_driving_expired?: boolean
          origin?: string
          phone_s?: number
          polyline?: string
          reason?: string | null
          result?: Json | null
          scored?: boolean
          scoring_version?: number
          slowdowns?: number
          speedups?: number
          started_at?: string
          turns?: number
          tz?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_achievements: {
        Row: {
          achievement_id: string
          unlocked_at: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          achievement_id: string
          unlocked_at?: string
          user_id: string
        }
        Update: {
          achievement_id?: string
          unlocked_at?: string
          user_id?: string
        }
        Relationships: []
      }
      weekly_challenges: {
        Row: {
          completed_at: string | null
          completed_by_trip: string | null
          created_at: string
          league_week: string
          slot: number
          template_id: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          completed_at?: string | null
          completed_by_trip?: string | null
          created_at?: string
          league_week: string
          slot: number
          template_id: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          completed_by_trip?: string | null
          created_at?: string
          league_week?: string
          slot?: number
          template_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_challenges_completed_by_trip_fkey"
            columns: ["completed_by_trip"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_challenges_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "challenge_templates"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_terms: { Args: { p_version: string }; Returns: undefined }
      block_user: { Args: { p_user_id: string }; Returns: undefined }
      cancel_friend_request: { Args: { p_user_id: string }; Returns: undefined }
      check_username: { Args: { p: string }; Returns: Json }
      claim_live_activity_start: {
        Args: { p_client_trip_id: string; p_device_id: string; p_leg?: number }
        Returns: Json
      }
      claim_push_batch: {
        Args: { p_lease_seconds: number; p_limit: number }
        Returns: Json
      }
      claim_username: { Args: { p: string }; Returns: undefined }
      complete_onboarding: {
        Args: { p_terms_version: string }
        Returns: undefined
      }
      export_account: { Args: { p_user: string }; Returns: Json }
      get_current_speed_limit: {
        Args: { p_heading: number; p_lat: number; p_lon: number }
        Returns: {
          distance_m: number
          highway: string
          is_default: boolean
          limit_mph: number
          name: string
          osm_id: number
        }[]
      }
      get_friends_board: { Args: Record<PropertyKey, never>; Returns: Json }
      get_heatmap: { Args: { p_user_id: string }; Returns: Json }
      get_member_stats: { Args: { p_user_id: string }; Returns: Json }
      get_my_summary: { Args: Record<PropertyKey, never>; Returns: Json }
      get_notification_prefs: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      get_profile: { Args: { p_username: string }; Returns: Json }
      list_blocked: { Args: Record<PropertyKey, never>; Returns: Json }
      list_friends: { Args: Record<PropertyKey, never>; Returns: Json }
      list_my_drives: {
        Args: { p_before?: string; p_limit?: number }
        Returns: Json
      }
      list_my_route_pool: {
        Args: { p_after?: string; p_limit?: number }
        Returns: Json
      }
      osm_claim_fill_cell: {
        Args: { p_version?: number; p_x: number; p_y: number }
        Returns: string
      }
      osm_finish_fill_cell: {
        Args: {
          p_outcome: string
          p_version?: number
          p_way_count: number
          p_x: number
          p_y: number
        }
        Returns: boolean
      }
      osm_upsert_ways: { Args: { p_ways: Json }; Returns: number }
      purge_auth_audit: {
        Args: { p_email: string; p_user: string }
        Returns: number
      }
      push_receipts_due: { Args: { p_limit: number }; Returns: Json }
      put_limits_cache: {
        Args: {
          p_heading: number
          p_key: string
          p_limit_mph: number
          p_line: Json
          p_ttl_days: number
        }
        Returns: string
      }
      record_push_outcomes: { Args: { p: Json }; Returns: number }
      record_push_receipts: { Args: { p: Json }; Returns: number }
      register_device: {
        Args: {
          p_device_id: string
          p_live_activity_token?: string
          p_platform: string
          p_push_token?: string
        }
        Returns: Json
      }
      release_device: { Args: { p_device_id: string }; Returns: undefined }
      release_live_activity_start: {
        Args: { p_client_trip_id: string; p_device_id: string; p_leg?: number }
        Returns: boolean
      }
      remove_friend: { Args: { p_user_id: string }; Returns: undefined }
      report_target: {
        Args: {
          p_kind: string
          p_note?: string
          p_reason: string
          p_target_id: string
        }
        Returns: undefined
      }
      require_service_role: { Args: { p_fn: string }; Returns: undefined }
      respond_friend_request: {
        Args: { p_accept: boolean; p_user_id: string }
        Returns: undefined
      }
      search_users: { Args: { p_query: string }; Returns: Json }
      send_friend_request: { Args: { p_user_id: string }; Returns: Json }
      set_notification_prefs: {
        Args: {
          p_leagues?: boolean
          p_quiet_enabled?: boolean
          p_quiet_end?: string
          p_quiet_start?: string
          p_social?: boolean
          p_tz?: string
          p_weekly_recap?: boolean
        }
        Returns: Json
      }
      speed_limit_candidates: {
        Args: { p_lat: number; p_lng: number; p_radius_m: number }
        Returns: {
          bearing_deg: number
          distance_m: number
          highway: string
          limit_mph: number
          oneway: number
          provider: string
          segment_key: string
        }[]
      }
      speed_limit_tiles: { Args: { p_keys: string[] }; Returns: Json }
      take_global_rate_limit: {
        Args: { p_key: string; p_max: number; p_window: string }
        Returns: boolean
      }
      take_rate_limit: {
        Args: { p_key: string; p_max: number; p_user: string; p_window: string }
        Returns: boolean
      }
      unblock_user: { Args: { p_user_id: string }; Returns: undefined }
      update_profile: {
        Args: {
          p_heatmap_visibility?: string
          p_share_achievements?: boolean
          p_share_categories?: boolean
          p_share_rating?: boolean
          p_share_stats?: boolean
          p_state?: string
          p_units?: string
        }
        Returns: undefined
      }
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
