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
          value: Json
        }
        Insert: {
          is_public?: boolean
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          is_public?: boolean
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      baselines: {
        Row: {
          computed_at: string
          created_at: string
          medians: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          computed_at?: string
          created_at?: string
          medians?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          computed_at?: string
          created_at?: string
          medians?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      consents: {
        Row: {
          actor: string
          granted_at: string
          id: string
          revoked_at: string | null
          type: string
          user_id: string
          version: string
        }
        Insert: {
          actor?: string
          granted_at?: string
          id?: string
          revoked_at?: string | null
          type: string
          user_id: string
          version: string
        }
        Update: {
          actor?: string
          granted_at?: string
          id?: string
          revoked_at?: string | null
          type?: string
          user_id?: string
          version?: string
        }
        Relationships: []
      }
      devices: {
        Row: {
          app_version: string | null
          capability_tier: string
          created_at: string
          drive_state: string
          drive_state_at: string | null
          id: string
          last_seen_at: string
          model: string | null
          os_version: string | null
          permissions: Json
          platform: string
          push_token: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          app_version?: string | null
          capability_tier?: string
          created_at?: string
          drive_state?: string
          drive_state_at?: string | null
          id: string
          last_seen_at?: string
          model?: string | null
          os_version?: string | null
          permissions?: Json
          platform: string
          push_token?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          app_version?: string | null
          capability_tier?: string
          created_at?: string
          drive_state?: string
          drive_state_at?: string | null
          id?: string
          last_seen_at?: string
          model?: string | null
          os_version?: string | null
          permissions?: Json
          platform?: string
          push_token?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      event_disputes: {
        Row: {
          auto_accepted: boolean
          consumed_allowance: boolean
          created_at: string
          decided_at: string
          denied_reason: string | null
          event_id: string
          id: string
          note: string | null
          reason: string
          segment_key: string | null
          stated_limit_mph: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          auto_accepted?: boolean
          consumed_allowance?: boolean
          created_at?: string
          decided_at?: string
          denied_reason?: string | null
          event_id: string
          id?: string
          note?: string | null
          reason: string
          segment_key?: string | null
          stated_limit_mph?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          auto_accepted?: boolean
          consumed_allowance?: boolean
          created_at?: string
          decided_at?: string
          denied_reason?: string | null
          event_id?: string
          id?: string
          note?: string | null
          reason?: string
          segment_key?: string | null
          stated_limit_mph?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_disputes_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: true
            referencedRelation: "trip_events"
            referencedColumns: ["id"]
          },
        ]
      }
      global_rate_limits: {
        Row: {
          count: number
          created_at: string
          key: string
          updated_at: string
          window_start: string
        }
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
          deliver_after: string
          dismissed_at: string | null
          id: string
          payload: Json
          push_after: string
          push_attempts: number
          push_claimed_at: string | null
          push_reason: string | null
          push_state: string
          pushed_at: string | null
          read_at: string | null
          ref_id: string | null
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          dedupe_key: string
          deliver_after?: string
          dismissed_at?: string | null
          id?: string
          payload: Json
          push_after?: string
          push_attempts?: number
          push_claimed_at?: string | null
          push_reason?: string | null
          push_state?: string
          pushed_at?: string | null
          read_at?: string | null
          ref_id?: string | null
          type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          dedupe_key?: string
          deliver_after?: string
          dismissed_at?: string | null
          id?: string
          payload?: Json
          push_after?: string
          push_attempts?: number
          push_claimed_at?: string | null
          push_reason?: string | null
          push_state?: string
          pushed_at?: string | null
          read_at?: string | null
          ref_id?: string | null
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      invites: {
        Row: {
          code_hash: string
          created_at: string
          expires_at: string
          family_id: string | null
          id: string
          issuer_id: string
          max_uses: number
          revoked: boolean
          role: string | null
          type: string
          updated_at: string
          uses: number
        }
        Insert: {
          code_hash: string
          created_at?: string
          expires_at: string
          family_id?: string | null
          id?: string
          issuer_id: string
          max_uses?: number
          revoked?: boolean
          role?: string | null
          type: string
          updated_at?: string
          uses?: number
        }
        Update: {
          code_hash?: string
          created_at?: string
          expires_at?: string
          family_id?: string | null
          id?: string
          issuer_id?: string
          max_uses?: number
          revoked?: boolean
          role?: string | null
          type?: string
          updated_at?: string
          uses?: number
        }
        Relationships: []
      }
      job_leases: {
        Row: {
          created_at: string
          expires_at: string
          holder: string
          job: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          holder: string
          job: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          holder?: string
          job?: string
          updated_at?: string
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
          reports: number
          segment_key: string
          stated_limits_mph: number[]
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          reports?: number
          segment_key: string
          stated_limits_mph?: number[]
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          reports?: number
          segment_key?: string
          stated_limits_mph?: number[]
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      notification_prefs: {
        Row: {
          categories: Json
          created_at: string
          local_sent_count: number
          local_sent_day: string | null
          quiet_enabled: boolean | null
          quiet_end: string | null
          quiet_start: string | null
          tz: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          categories?: Json
          created_at?: string
          local_sent_count?: number
          local_sent_day?: string | null
          quiet_enabled?: boolean | null
          quiet_end?: string | null
          quiet_start?: string | null
          tz?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          categories?: Json
          created_at?: string
          local_sent_count?: number
          local_sent_day?: string | null
          quiet_enabled?: boolean | null
          quiet_end?: string | null
          quiet_start?: string | null
          tz?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      private_profiles: {
        Row: {
          birth_date: string | null
          created_at: string
          guardian_link_status: string
          guardian_user_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          birth_date?: string | null
          created_at?: string
          guardian_link_status?: string
          guardian_user_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          birth_date?: string | null
          created_at?: string
          guardian_link_status?: string
          guardian_user_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          age_band: string
          avatar_path: string | null
          created_at: string
          display_name: string
          driving_stage: string
          flags: Json
          id: string
          level: number
          locale: string
          profile_visibility: string
          units: string
          updated_at: string
        }
        Insert: {
          age_band?: string
          avatar_path?: string | null
          created_at?: string
          display_name?: string
          driving_stage?: string
          flags?: Json
          id: string
          level?: number
          locale?: string
          profile_visibility?: string
          units?: string
          updated_at?: string
        }
        Update: {
          age_band?: string
          avatar_path?: string | null
          created_at?: string
          display_name?: string
          driving_stage?: string
          flags?: Json
          id?: string
          level?: number
          locale?: string
          profile_visibility?: string
          units?: string
          updated_at?: string
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
          {
            foreignKeyName: "push_deliveries_token_fkey"
            columns: ["token"]
            isOneToOne: false
            referencedRelation: "push_registrations"
            referencedColumns: ["token"]
          },
        ]
      }
      push_registrations: {
        Row: {
          created_at: string
          device_id: string
          last_registered_at: string
          platform: string
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          device_id: string
          last_registered_at?: string
          platform: string
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          device_id?: string
          last_registered_at?: string
          platform?: string
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_registrations_device_fkey"
            columns: ["user_id", "device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["user_id", "id"]
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
      score_daily: {
        Row: {
          band: string | null
          camera_day: boolean
          created_at: string
          day: string
          driving_s: number
          exposure: number
          good_day: boolean
          long_term_score: number | null
          phone_free_day: boolean
          provisional: boolean
          safe_day: boolean
          severe_events: number
          trips_scored: number
          updated_at: string
          user_id: string
        }
        Insert: {
          band?: string | null
          camera_day?: boolean
          created_at?: string
          day: string
          driving_s?: number
          exposure?: number
          good_day?: boolean
          long_term_score?: number | null
          phone_free_day?: boolean
          provisional?: boolean
          safe_day?: boolean
          severe_events?: number
          trips_scored?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          band?: string | null
          camera_day?: boolean
          created_at?: string
          day?: string
          driving_s?: number
          exposure?: number
          good_day?: boolean
          long_term_score?: number | null
          phone_free_day?: boolean
          provisional?: boolean
          safe_day?: boolean
          severe_events?: number
          trips_scored?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      trip_events: {
        Row: {
          alert_shown: boolean
          category: string
          client_event_id: string
          confidence: number
          context: Json
          context_multiplier: number
          corrected: boolean
          created_at: string
          deduction: number | null
          duration_ms: number
          id: string
          lat: number | null
          lng: number | null
          measured: Json
          severity: number
          source: string
          started_at: string
          status: string
          trip_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          alert_shown?: boolean
          category: string
          client_event_id: string
          confidence: number
          context?: Json
          context_multiplier: number
          corrected?: boolean
          created_at?: string
          deduction?: number | null
          duration_ms: number
          id?: string
          lat?: number | null
          lng?: number | null
          measured?: Json
          severity: number
          source: string
          started_at: string
          status: string
          trip_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          alert_shown?: boolean
          category?: string
          client_event_id?: string
          confidence?: number
          context?: Json
          context_multiplier?: number
          corrected?: boolean
          created_at?: string
          deduction?: number | null
          duration_ms?: number
          id?: string
          lat?: number | null
          lng?: number | null
          measured?: Json
          severity?: number
          source?: string
          started_at?: string
          status?: string
          trip_id?: string
          updated_at?: string
          user_id?: string
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
          camera_session: boolean
          category_deductions: Json
          client_trip_id: string
          conditions: Json
          created_at: string
          data_quality: string
          deleted_at: string | null
          distance_m: number
          duration_s: number
          end_geohash5: string | null
          end_label: string | null
          ended_at: string
          exposure: number
          had_severe_event: boolean
          id: string
          incomplete: boolean
          limit_coverage_pct: number | null
          local_day: string
          mode: string
          notes: string | null
          polyline: string
          role: string
          role_confidence: number | null
          role_source: string | null
          rows_digest: Json
          score: number | null
          scored_without_trace: boolean
          scoring_version: number
          start_geohash5: string | null
          start_label: string | null
          started_at: string
          status: string
          trace_path: string | null
          tz: string
          unscored_reason: string | null
          updated_at: string
          user_id: string
          vehicle_id: string | null
        }
        Insert: {
          camera_session?: boolean
          category_deductions?: Json
          client_trip_id: string
          conditions?: Json
          created_at?: string
          data_quality: string
          deleted_at?: string | null
          distance_m: number
          duration_s: number
          end_geohash5?: string | null
          end_label?: string | null
          ended_at: string
          exposure: number
          had_severe_event?: boolean
          id?: string
          incomplete?: boolean
          limit_coverage_pct?: number | null
          local_day: string
          mode: string
          notes?: string | null
          polyline?: string
          role: string
          role_confidence?: number | null
          role_source?: string | null
          rows_digest?: Json
          score?: number | null
          scored_without_trace?: boolean
          scoring_version?: number
          start_geohash5?: string | null
          start_label?: string | null
          started_at: string
          status: string
          trace_path?: string | null
          tz: string
          unscored_reason?: string | null
          updated_at?: string
          user_id: string
          vehicle_id?: string | null
        }
        Update: {
          camera_session?: boolean
          category_deductions?: Json
          client_trip_id?: string
          conditions?: Json
          created_at?: string
          data_quality?: string
          deleted_at?: string | null
          distance_m?: number
          duration_s?: number
          end_geohash5?: string | null
          end_label?: string | null
          ended_at?: string
          exposure?: number
          had_severe_event?: boolean
          id?: string
          incomplete?: boolean
          limit_coverage_pct?: number | null
          local_day?: string
          mode?: string
          notes?: string | null
          polyline?: string
          role?: string
          role_confidence?: number | null
          role_source?: string | null
          rows_digest?: Json
          score?: number | null
          scored_without_trace?: boolean
          scoring_version?: number
          start_geohash5?: string | null
          start_label?: string | null
          started_at?: string
          status?: string
          trace_path?: string | null
          tz?: string
          unscored_reason?: string | null
          updated_at?: string
          user_id?: string
          vehicle_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      age_band_rank: { Args: { p_band: string }; Returns: number }
      apply_recompute: {
        Args: {
          p_baselines: Json
          p_day: Json
          p_events: Json
          p_scored: Json
          p_trip_id: string
          p_user: string
        }
        Returns: Json
      }
      apply_trip: { Args: { p: Json }; Returns: Json }
      claim_push_batch: {
        Args: { p_lease_seconds: number; p_limit: number }
        Returns: Json
      }
      clear_trace_paths: { Args: { p_keys: string[] }; Returns: number }
      count_dispute_allowance: { Args: { p_user: string }; Returns: Json }
      create_guardian_invite: { Args: never; Returns: Json }
      derive_age_band: { Args: { birth_date: string }; Returns: string }
      derive_age_band_on: {
        Args: { p_as_of: string; p_birth_date: string }
        Returns: string
      }
      dismiss_inbox: { Args: { p_ids: string[] }; Returns: number }
      dispatch_purge_traces: { Args: never; Returns: string }
      dispatch_push: { Args: never; Returns: string }
      expired_trace_object_keys: {
        Args: { p_after_name: string; p_limit: number }
        Returns: Json
      }
      guardian_link_state: { Args: never; Returns: Json }
      inbox_subject_gone: {
        Args: { p_payload: Json; p_ref: string; p_type: string; p_user: string }
        Returns: boolean
      }
      is_known_tz: { Args: { p_tz: string }; Returns: boolean }
      is_short_drive: {
        Args: { p_distance_m: number; p_duration_s: number }
        Returns: boolean
      }
      is_underage: { Args: { p_user: string }; Returns: boolean }
      mark_inbox_read: { Args: { p_ids: string[] }; Returns: number }
      merge_own_profile_flags: { Args: { patch: Json }; Returns: Json }
      notification_defaults: { Args: never; Returns: Json }
      purge_traces_signature: {
        Args: { p_key: string; p_ts: number }
        Returns: string
      }
      push_receipts_due: { Args: { p_limit: number }; Returns: Json }
      push_sweep_signature: {
        Args: { p_key: string; p_ts: number }
        Returns: string
      }
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
      record_dispute: {
        Args: {
          p_event_id: string
          p_note: string
          p_reason: string
          p_stated_limit_mph: number
          p_user: string
        }
        Returns: Json
      }
      record_push_outcomes: { Args: { p: Json }; Returns: number }
      record_push_receipts: { Args: { p: Json }; Returns: number }
      rederive_age_bands: { Args: never; Returns: number }
      register_push_token: {
        Args: { p_device_id: string; p_token: string }
        Returns: undefined
      }
      release_job_lease: {
        Args: { p_holder: string; p_job: string }
        Returns: boolean
      }
      require_baselines: {
        Args: { p_baselines: Json; p_fn: string }
        Returns: undefined
      }
      require_keys: {
        Args: { p_fn: string; p_keys: string[]; p_obj: Json; p_prefix: string }
        Returns: undefined
      }
      require_score_days: {
        Args: { p_days: Json; p_fn: string }
        Returns: undefined
      }
      require_scored_trip: {
        Args: { p_fn: string; p_scored: Json }
        Returns: Record<string, unknown>
      }
      require_service_role: { Args: { p_fn: string }; Returns: undefined }
      require_type: {
        Args: { p_fn: string; p_name: string; p_type: string; p_value: Json }
        Returns: undefined
      }
      set_birth_date: { Args: { p_birth_date: string }; Returns: undefined }
      set_trip_role_row: {
        Args: { p_role: string; p_trip_id: string; p_user: string }
        Returns: Json
      }
      soft_delete_trip: {
        Args: { p_trip_id: string; p_user: string }
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
      take_job_lease: {
        Args: { p_holder: string; p_job: string; p_seconds: number }
        Returns: boolean
      }
      take_rate_limit: {
        Args: { p_key: string; p_max: number; p_user: string; p_window: string }
        Returns: boolean
      }
      underage_identity_keys: { Args: { p_data: Json }; Returns: Json }
      underage_object_keys: { Args: { p_limit: number }; Returns: Json }
      underage_object_keys_after: {
        Args: { p_after_bucket: string; p_after_name: string; p_limit: number }
        Returns: Json
      }
      unregister_push_token: { Args: { p_token: string }; Returns: boolean }
      upsert_baselines: {
        Args: { p_baselines: Json; p_user: string }
        Returns: undefined
      }
      upsert_score_day: {
        Args: { p_days: Json; p_user: string }
        Returns: undefined
      }
      user_local_date: {
        Args: { p_at?: string; p_user: string }
        Returns: string
      }
      user_tz: { Args: { p_user: string }; Returns: string }
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
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
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
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
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
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
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

