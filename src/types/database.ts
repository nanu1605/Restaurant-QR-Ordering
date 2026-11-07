export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      announcement_dismissals: {
        Row: {
          announcement_id: string
          dismissed_at: string
          user_id: string
        }
        Insert: {
          announcement_id: string
          dismissed_at?: string
          user_id: string
        }
        Update: {
          announcement_id?: string
          dismissed_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_dismissals_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
        ]
      }
      announcement_emails: {
        Row: {
          announcement_id: string
          restaurant_id: string
          sent_at: string
        }
        Insert: {
          announcement_id: string
          restaurant_id: string
          sent_at?: string
        }
        Update: {
          announcement_id?: string
          restaurant_id?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_emails_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcement_emails_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      announcements: {
        Row: {
          body: string
          body_hi: string | null
          cities: string[] | null
          created_at: string
          created_by: string | null
          dismissible: boolean
          email: boolean
          ended_at: string | null
          ends_at: string | null
          id: string
          panels: string[]
          plan_ids: string[] | null
          restaurant_ids: string[] | null
          starts_at: string
          title: string
          title_hi: string | null
          updated_at: string
        }
        Insert: {
          body: string
          body_hi?: string | null
          cities?: string[] | null
          created_at?: string
          created_by?: string | null
          dismissible?: boolean
          email?: boolean
          ended_at?: string | null
          ends_at?: string | null
          id?: string
          panels: string[]
          plan_ids?: string[] | null
          restaurant_ids?: string[] | null
          starts_at?: string
          title: string
          title_hi?: string | null
          updated_at?: string
        }
        Update: {
          body?: string
          body_hi?: string | null
          cities?: string[] | null
          created_at?: string
          created_by?: string | null
          dismissible?: boolean
          email?: boolean
          ended_at?: string | null
          ends_at?: string | null
          id?: string
          panels?: string[]
          plan_ids?: string[] | null
          restaurant_ids?: string[] | null
          starts_at?: string
          title?: string
          title_hi?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          actor_label: string
          actor_role: Database["public"]["Enums"]["member_role"] | null
          actor_type: Database["public"]["Enums"]["actor_type"]
          actor_user_id: string | null
          after: Json | null
          before: Json | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          reason: string | null
          restaurant_id: string | null
          support_session_id: string | null
        }
        Insert: {
          action: string
          actor_label: string
          actor_role?: Database["public"]["Enums"]["member_role"] | null
          actor_type: Database["public"]["Enums"]["actor_type"]
          actor_user_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          reason?: string | null
          restaurant_id?: string | null
          support_session_id?: string | null
        }
        Update: {
          action?: string
          actor_label?: string
          actor_role?: Database["public"]["Enums"]["member_role"] | null
          actor_type?: Database["public"]["Enums"]["actor_type"]
          actor_user_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          reason?: string | null
          restaurant_id?: string | null
          support_session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_support_session_id_fkey"
            columns: ["support_session_id"]
            isOneToOne: false
            referencedRelation: "support_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      bill_payments: {
        Row: {
          amount_paise: number
          bill_id: string
          created_at: string
          id: string
          is_void: boolean
          mode: Database["public"]["Enums"]["payment_mode"]
          recorded_by: string | null
          reference: string | null
          restaurant_id: string
          updated_at: string
        }
        Insert: {
          amount_paise: number
          bill_id: string
          created_at?: string
          id?: string
          is_void?: boolean
          mode: Database["public"]["Enums"]["payment_mode"]
          recorded_by?: string | null
          reference?: string | null
          restaurant_id: string
          updated_at?: string
        }
        Update: {
          amount_paise?: number
          bill_id?: string
          created_at?: string
          id?: string
          is_void?: boolean
          mode?: Database["public"]["Enums"]["payment_mode"]
          recorded_by?: string | null
          reference?: string | null
          restaurant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bill_payments_restaurant_id_bill_id_fkey"
            columns: ["restaurant_id", "bill_id"]
            isOneToOne: false
            referencedRelation: "bills"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "bill_payments_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      bills: {
        Row: {
          cgst_paise: number
          created_at: string
          discount_paise: number
          discount_reason: string | null
          discount_type: Database["public"]["Enums"]["discount_type"]
          discount_value: number
          document_type: Database["public"]["Enums"]["document_type"]
          financial_year: string
          generated_at: string
          generated_by: string | null
          grand_total_paise: number
          gst_mode: Database["public"]["Enums"]["gst_mode"]
          gst_rate_bps: number
          id: string
          invoice_number: string
          invoice_seq: number
          line_items: Json
          paid_at: string | null
          payment_status: Database["public"]["Enums"]["payment_status"]
          prices_include_tax: boolean
          print_count: number
          restaurant_id: string
          restaurant_snapshot: Json
          round_off_paise: number
          service_charge_bps: number
          service_charge_paise: number
          session_id: string
          sgst_paise: number
          status: Database["public"]["Enums"]["bill_status"]
          subtotal_paise: number
          table_label_snapshot: string
          taxable_paise: number
          total_tax_paise: number
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
          waiter_id: string | null
          waiter_name_snapshot: string | null
        }
        Insert: {
          cgst_paise?: number
          created_at?: string
          discount_paise?: number
          discount_reason?: string | null
          discount_type?: Database["public"]["Enums"]["discount_type"]
          discount_value?: number
          document_type: Database["public"]["Enums"]["document_type"]
          financial_year: string
          generated_at?: string
          generated_by?: string | null
          grand_total_paise: number
          gst_mode: Database["public"]["Enums"]["gst_mode"]
          gst_rate_bps: number
          id?: string
          invoice_number: string
          invoice_seq: number
          line_items: Json
          paid_at?: string | null
          payment_status?: Database["public"]["Enums"]["payment_status"]
          prices_include_tax: boolean
          print_count?: number
          restaurant_id: string
          restaurant_snapshot: Json
          round_off_paise?: number
          service_charge_bps?: number
          service_charge_paise?: number
          session_id: string
          sgst_paise?: number
          status?: Database["public"]["Enums"]["bill_status"]
          subtotal_paise: number
          table_label_snapshot: string
          taxable_paise: number
          total_tax_paise?: number
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
          waiter_id?: string | null
          waiter_name_snapshot?: string | null
        }
        Update: {
          cgst_paise?: number
          created_at?: string
          discount_paise?: number
          discount_reason?: string | null
          discount_type?: Database["public"]["Enums"]["discount_type"]
          discount_value?: number
          document_type?: Database["public"]["Enums"]["document_type"]
          financial_year?: string
          generated_at?: string
          generated_by?: string | null
          grand_total_paise?: number
          gst_mode?: Database["public"]["Enums"]["gst_mode"]
          gst_rate_bps?: number
          id?: string
          invoice_number?: string
          invoice_seq?: number
          line_items?: Json
          paid_at?: string | null
          payment_status?: Database["public"]["Enums"]["payment_status"]
          prices_include_tax?: boolean
          print_count?: number
          restaurant_id?: string
          restaurant_snapshot?: Json
          round_off_paise?: number
          service_charge_bps?: number
          service_charge_paise?: number
          session_id?: string
          sgst_paise?: number
          status?: Database["public"]["Enums"]["bill_status"]
          subtotal_paise?: number
          table_label_snapshot?: string
          taxable_paise?: number
          total_tax_paise?: number
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
          waiter_id?: string | null
          waiter_name_snapshot?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bills_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bills_restaurant_id_session_id_fkey"
            columns: ["restaurant_id", "session_id"]
            isOneToOne: false
            referencedRelation: "table_sessions"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "bills_restaurant_id_waiter_id_fkey"
            columns: ["restaurant_id", "waiter_id"]
            isOneToOne: false
            referencedRelation: "waiters"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      cron_runs: {
        Row: {
          detail: string | null
          finished_at: string
          id: number
          job: string
          ok: boolean
          started_at: string
          step: string
        }
        Insert: {
          detail?: string | null
          finished_at: string
          id?: never
          job: string
          ok: boolean
          started_at: string
          step: string
        }
        Update: {
          detail?: string | null
          finished_at?: string
          id?: never
          job?: string
          ok?: boolean
          started_at?: string
          step?: string
        }
        Relationships: []
      }
      dining_tables: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          label: string
          qr_token: string
          restaurant_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          label: string
          qr_token: string
          restaurant_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          qr_token?: string
          restaurant_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dining_tables_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_log: {
        Row: {
          created_at: string
          error: string | null
          http_status: number | null
          id: number
          kind: string
          provider_id: string | null
          recipient_hashes: string[]
          status: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          error?: string | null
          http_status?: number | null
          id?: never
          kind: string
          provider_id?: string | null
          recipient_hashes: string[]
          status: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          error?: string | null
          http_status?: number | null
          id?: never
          kind?: string
          provider_id?: string | null
          recipient_hashes?: string[]
          status?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      invoice_counters: {
        Row: {
          created_at: string
          financial_year: string
          last_seq: number
          restaurant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          financial_year: string
          last_seq?: number
          restaurant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          financial_year?: string
          last_seq?: number
          restaurant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_counters_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_events: {
        Row: {
          actor_id: string | null
          automatic: boolean
          body: string | null
          created_at: string
          from_value: string | null
          id: string
          kind: string
          lead_id: string
          to_value: string | null
        }
        Insert: {
          actor_id?: string | null
          automatic?: boolean
          body?: string | null
          created_at?: string
          from_value?: string | null
          id?: string
          kind: string
          lead_id: string
          to_value?: string | null
        }
        Update: {
          actor_id?: string | null
          automatic?: boolean
          body?: string | null
          created_at?: string
          from_value?: string | null
          id?: string
          kind?: string
          lead_id?: string
          to_value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "site_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_addon_groups: {
        Row: {
          created_at: string
          id: string
          max_select: number
          min_select: number
          name: string
          restaurant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          max_select?: number
          min_select?: number
          name: string
          restaurant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          max_select?: number
          min_select?: number
          name?: string
          restaurant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_addon_groups_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_addons: {
        Row: {
          created_at: string
          group_id: string
          id: string
          is_available: boolean
          name: string
          price_paise: number
          restaurant_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          group_id: string
          id?: string
          is_available?: boolean
          name: string
          price_paise?: number
          restaurant_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          group_id?: string
          id?: string
          is_available?: boolean
          name?: string
          price_paise?: number
          restaurant_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_addons_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_addons_restaurant_id_group_id_fkey"
            columns: ["restaurant_id", "group_id"]
            isOneToOne: false
            referencedRelation: "menu_addon_groups"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      menu_categories: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          name_hi: string | null
          name_hi_auto: string | null
          name_hi_auto_tried_at: string | null
          restaurant_id: string
          sort_order: number
          source: Database["public"]["Enums"]["category_source"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          name_hi?: string | null
          name_hi_auto?: string | null
          name_hi_auto_tried_at?: string | null
          restaurant_id: string
          sort_order?: number
          source?: Database["public"]["Enums"]["category_source"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          name_hi?: string | null
          name_hi_auto?: string | null
          name_hi_auto_tried_at?: string | null
          restaurant_id?: string
          sort_order?: number
          source?: Database["public"]["Enums"]["category_source"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_categories_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_imports: {
        Row: {
          completed_at: string | null
          cost_paise: number | null
          created_at: string
          created_by: string | null
          draft: Json | null
          error: string | null
          file_paths: string[]
          files_removed_at: string | null
          id: string
          imported_counts: Json | null
          input_tokens: number
          model: string | null
          output_tokens: number
          page_count: number
          pages: Json
          raw_result: Json | null
          restaurant_id: string
          source: Database["public"]["Enums"]["menu_import_source"]
          status: Database["public"]["Enums"]["menu_import_status"]
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          cost_paise?: number | null
          created_at?: string
          created_by?: string | null
          draft?: Json | null
          error?: string | null
          file_paths?: string[]
          files_removed_at?: string | null
          id?: string
          imported_counts?: Json | null
          input_tokens?: number
          model?: string | null
          output_tokens?: number
          page_count: number
          pages?: Json
          raw_result?: Json | null
          restaurant_id: string
          source: Database["public"]["Enums"]["menu_import_source"]
          status: Database["public"]["Enums"]["menu_import_status"]
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          cost_paise?: number | null
          created_at?: string
          created_by?: string | null
          draft?: Json | null
          error?: string | null
          file_paths?: string[]
          files_removed_at?: string | null
          id?: string
          imported_counts?: Json | null
          input_tokens?: number
          model?: string | null
          output_tokens?: number
          page_count?: number
          pages?: Json
          raw_result?: Json | null
          restaurant_id?: string
          source?: Database["public"]["Enums"]["menu_import_source"]
          status?: Database["public"]["Enums"]["menu_import_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_imports_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_item_addon_groups: {
        Row: {
          group_id: string
          menu_item_id: string
          restaurant_id: string
        }
        Insert: {
          group_id: string
          menu_item_id: string
          restaurant_id: string
        }
        Update: {
          group_id?: string
          menu_item_id?: string
          restaurant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_item_addon_groups_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_addon_groups_restaurant_id_group_id_fkey"
            columns: ["restaurant_id", "group_id"]
            isOneToOne: false
            referencedRelation: "menu_addon_groups"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "menu_item_addon_groups_restaurant_id_menu_item_id_fkey"
            columns: ["restaurant_id", "menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      menu_item_variants: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          menu_item_id: string
          name: string
          price_paise: number
          restaurant_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          menu_item_id: string
          name: string
          price_paise: number
          restaurant_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          menu_item_id?: string
          name?: string
          price_paise?: number
          restaurant_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_item_variants_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_variants_restaurant_id_menu_item_id_fkey"
            columns: ["restaurant_id", "menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      menu_items: {
        Row: {
          category_id: string
          created_at: string
          description: string | null
          food_type: Database["public"]["Enums"]["food_type"]
          id: string
          image_path: string | null
          is_active: boolean
          is_available: boolean
          name: string
          name_hi: string | null
          name_hi_auto: string | null
          name_hi_auto_tried_at: string | null
          price_paise: number
          restaurant_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          category_id: string
          created_at?: string
          description?: string | null
          food_type: Database["public"]["Enums"]["food_type"]
          id?: string
          image_path?: string | null
          is_active?: boolean
          is_available?: boolean
          name: string
          name_hi?: string | null
          name_hi_auto?: string | null
          name_hi_auto_tried_at?: string | null
          price_paise?: number
          restaurant_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          category_id?: string
          created_at?: string
          description?: string | null
          food_type?: Database["public"]["Enums"]["food_type"]
          id?: string
          image_path?: string | null
          is_active?: boolean
          is_available?: boolean
          name?: string
          name_hi?: string | null
          name_hi_auto?: string | null
          name_hi_auto_tried_at?: string | null
          price_paise?: number
          restaurant_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_items_restaurant_id_category_id_fkey"
            columns: ["restaurant_id", "category_id"]
            isOneToOne: false
            referencedRelation: "menu_categories"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "menu_items_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      metrics_platform_daily: {
        Row: {
          day: string
          leads_created: number
          pricing_visitors: number | null
          restaurants_onboarded: number
          signups_completed: number
          signups_started: number
          website_visitors: number | null
        }
        Insert: {
          day: string
          leads_created?: number
          pricing_visitors?: number | null
          restaurants_onboarded?: number
          signups_completed?: number
          signups_started?: number
          website_visitors?: number | null
        }
        Update: {
          day?: string
          leads_created?: number
          pricing_visitors?: number | null
          restaurants_onboarded?: number
          signups_completed?: number
          signups_started?: number
          website_visitors?: number | null
        }
        Relationships: []
      }
      metrics_subscription_daily: {
        Row: {
          autopay: boolean
          billing_cycle: Database["public"]["Enums"]["billing_cycle"] | null
          cancel_at_period_end: boolean
          current_period_end: string | null
          day: string
          grace_until: string | null
          health: string | null
          mrr_paise: number
          plan_id: string | null
          restaurant_id: string
          source: Database["public"]["Enums"]["subscription_source"] | null
          state: string
          trial_ends_at: string | null
        }
        Insert: {
          autopay?: boolean
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"] | null
          cancel_at_period_end?: boolean
          current_period_end?: string | null
          day: string
          grace_until?: string | null
          health?: string | null
          mrr_paise?: number
          plan_id?: string | null
          restaurant_id: string
          source?: Database["public"]["Enums"]["subscription_source"] | null
          state: string
          trial_ends_at?: string | null
        }
        Update: {
          autopay?: boolean
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"] | null
          cancel_at_period_end?: boolean
          current_period_end?: string | null
          day?: string
          grace_until?: string | null
          health?: string | null
          mrr_paise?: number
          plan_id?: string | null
          restaurant_id?: string
          source?: Database["public"]["Enums"]["subscription_source"] | null
          state?: string
          trial_ends_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "metrics_subscription_daily_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metrics_subscription_daily_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      metrics_usage_daily: {
        Row: {
          addon_orders: number
          avg_session_minutes: number | null
          bills: number
          business_day: string
          customer_orders: number
          discount_paise: number
          gmv_paise: number
          hindi_orders: number
          hourly_orders: number[]
          items: number
          orders: number
          paid_card_paise: number
          paid_cash_paise: number
          paid_other_paise: number
          paid_upi_paise: number
          restaurant_id: string
          service_requests: number
          sessions_billed: number
          split_bills: number
          staff_orders: number
          tax_paise: number
          waiter_bills: number
        }
        Insert: {
          addon_orders?: number
          avg_session_minutes?: number | null
          bills?: number
          business_day: string
          customer_orders?: number
          discount_paise?: number
          gmv_paise?: number
          hindi_orders?: number
          hourly_orders?: number[]
          items?: number
          orders?: number
          paid_card_paise?: number
          paid_cash_paise?: number
          paid_other_paise?: number
          paid_upi_paise?: number
          restaurant_id: string
          service_requests?: number
          sessions_billed?: number
          split_bills?: number
          staff_orders?: number
          tax_paise?: number
          waiter_bills?: number
        }
        Update: {
          addon_orders?: number
          avg_session_minutes?: number | null
          bills?: number
          business_day?: string
          customer_orders?: number
          discount_paise?: number
          gmv_paise?: number
          hindi_orders?: number
          hourly_orders?: number[]
          items?: number
          orders?: number
          paid_card_paise?: number
          paid_cash_paise?: number
          paid_other_paise?: number
          paid_upi_paise?: number
          restaurant_id?: string
          service_requests?: number
          sessions_billed?: number
          split_bills?: number
          staff_orders?: number
          tax_paise?: number
          waiter_bills?: number
        }
        Relationships: [
          {
            foreignKeyName: "metrics_usage_daily_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      offers: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          cycles: Database["public"]["Enums"]["billing_cycle"][] | null
          description: string | null
          discount_kind: string
          discount_value: number
          duration_cycles: number | null
          ended_at: string | null
          id: string
          max_redemptions: number | null
          new_only: boolean
          plan_ids: string[] | null
          updated_at: string
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          cycles?: Database["public"]["Enums"]["billing_cycle"][] | null
          description?: string | null
          discount_kind: string
          discount_value: number
          duration_cycles?: number | null
          ended_at?: string | null
          id?: string
          max_redemptions?: number | null
          new_only?: boolean
          plan_ids?: string[] | null
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          cycles?: Database["public"]["Enums"]["billing_cycle"][] | null
          description?: string | null
          discount_kind?: string
          discount_value?: number
          duration_cycles?: number | null
          ended_at?: string | null
          id?: string
          max_redemptions?: number | null
          new_only?: boolean
          plan_ids?: string[] | null
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: []
      }
      order_items: {
        Row: {
          addons_snapshot: Json
          cancelled_at: string | null
          created_at: string
          food_type_snapshot: Database["public"]["Enums"]["food_type"]
          id: string
          item_name_snapshot: string
          menu_item_id: string
          note: string | null
          order_id: string
          quantity: number
          removed_at: string | null
          removed_by: string | null
          removed_reason: string | null
          restaurant_id: string
          served_at: string | null
          served_by: string | null
          session_id: string
          status: Database["public"]["Enums"]["order_item_status"]
          status_changed_at: string
          status_changed_by: string | null
          unit_price_paise: number
          updated_at: string
          variant_id: string | null
          variant_name_snapshot: string | null
        }
        Insert: {
          addons_snapshot?: Json
          cancelled_at?: string | null
          created_at?: string
          food_type_snapshot: Database["public"]["Enums"]["food_type"]
          id?: string
          item_name_snapshot: string
          menu_item_id: string
          note?: string | null
          order_id: string
          quantity: number
          removed_at?: string | null
          removed_by?: string | null
          removed_reason?: string | null
          restaurant_id: string
          served_at?: string | null
          served_by?: string | null
          session_id: string
          status?: Database["public"]["Enums"]["order_item_status"]
          status_changed_at?: string
          status_changed_by?: string | null
          unit_price_paise: number
          updated_at?: string
          variant_id?: string | null
          variant_name_snapshot?: string | null
        }
        Update: {
          addons_snapshot?: Json
          cancelled_at?: string | null
          created_at?: string
          food_type_snapshot?: Database["public"]["Enums"]["food_type"]
          id?: string
          item_name_snapshot?: string
          menu_item_id?: string
          note?: string | null
          order_id?: string
          quantity?: number
          removed_at?: string | null
          removed_by?: string | null
          removed_reason?: string | null
          restaurant_id?: string
          served_at?: string | null
          served_by?: string | null
          session_id?: string
          status?: Database["public"]["Enums"]["order_item_status"]
          status_changed_at?: string
          status_changed_by?: string | null
          unit_price_paise?: number
          updated_at?: string
          variant_id?: string | null
          variant_name_snapshot?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_restaurant_id_menu_item_id_fkey"
            columns: ["restaurant_id", "menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "order_items_restaurant_id_menu_item_id_variant_id_fkey"
            columns: ["restaurant_id", "menu_item_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "menu_item_variants"
            referencedColumns: ["restaurant_id", "menu_item_id", "id"]
          },
          {
            foreignKeyName: "order_items_restaurant_id_session_id_order_id_fkey"
            columns: ["restaurant_id", "session_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["restaurant_id", "session_id", "id"]
          },
        ]
      }
      orders: {
        Row: {
          client_device_id: string | null
          created_at: string
          customer_note: string | null
          decided_at: string | null
          decided_by: string | null
          guest_lang: string | null
          id: string
          idempotency_key: string
          placed_by_user_id: string | null
          placed_via: Database["public"]["Enums"]["order_placed_via"]
          reject_reason: string | null
          removed_at: string | null
          removed_by: string | null
          removed_reason: string | null
          restaurant_id: string
          round_number: number
          session_id: string
          status: Database["public"]["Enums"]["order_status"]
          updated_at: string
        }
        Insert: {
          client_device_id?: string | null
          created_at?: string
          customer_note?: string | null
          decided_at?: string | null
          decided_by?: string | null
          guest_lang?: string | null
          id?: string
          idempotency_key: string
          placed_by_user_id?: string | null
          placed_via: Database["public"]["Enums"]["order_placed_via"]
          reject_reason?: string | null
          removed_at?: string | null
          removed_by?: string | null
          removed_reason?: string | null
          restaurant_id: string
          round_number: number
          session_id: string
          status: Database["public"]["Enums"]["order_status"]
          updated_at?: string
        }
        Update: {
          client_device_id?: string | null
          created_at?: string
          customer_note?: string | null
          decided_at?: string | null
          decided_by?: string | null
          guest_lang?: string | null
          id?: string
          idempotency_key?: string
          placed_by_user_id?: string | null
          placed_via?: Database["public"]["Enums"]["order_placed_via"]
          reject_reason?: string | null
          removed_at?: string | null
          removed_by?: string | null
          removed_reason?: string | null
          restaurant_id?: string
          round_number?: number
          session_id?: string
          status?: Database["public"]["Enums"]["order_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_restaurant_id_session_id_fkey"
            columns: ["restaurant_id", "session_id"]
            isOneToOne: false
            referencedRelation: "table_sessions"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      password_resets: {
        Row: {
          code_hash: string
          created_at: string
          email: string
          expires_at: string
          id: string
          ip_hash: string | null
          tries: number
          used_at: string | null
          user_id: string | null
        }
        Insert: {
          code_hash: string
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          ip_hash?: string | null
          tries?: number
          used_at?: string | null
          user_id?: string | null
        }
        Update: {
          code_hash?: string
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          ip_hash?: string | null
          tries?: number
          used_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      plan_limit_events: {
        Row: {
          created_at: string
          feature: string | null
          id: number
          kind: string
          restaurant_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          feature?: string | null
          id?: never
          kind: string
          restaurant_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          feature?: string | null
          id?: never
          kind?: string
          restaurant_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "plan_limit_events_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          code: string
          created_at: string
          features: Json
          id: string
          is_active: boolean
          max_staff: number | null
          max_tables: number | null
          name: string
          price_monthly_paise: number
          price_yearly_paise: number
          razorpay_plan_id_monthly: string | null
          razorpay_plan_id_yearly: string | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          features?: Json
          id?: string
          is_active?: boolean
          max_staff?: number | null
          max_tables?: number | null
          name: string
          price_monthly_paise: number
          price_yearly_paise: number
          razorpay_plan_id_monthly?: string | null
          razorpay_plan_id_yearly?: string | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          features?: Json
          id?: string
          is_active?: boolean
          max_staff?: number | null
          max_tables?: number | null
          name?: string
          price_monthly_paise?: number
          price_yearly_paise?: number
          razorpay_plan_id_monthly?: string | null
          razorpay_plan_id_yearly?: string | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      platform_admins: {
        Row: {
          alerts_seen_at: string | null
          created_at: string
          digest: boolean
          disabled_at: string | null
          display_name: string | null
          invite_expires_at: string | null
          invite_token_hash: string | null
          invited_at: string | null
          invited_by: string | null
          joined_at: string | null
          role: string
          user_id: string
        }
        Insert: {
          alerts_seen_at?: string | null
          created_at?: string
          digest?: boolean
          disabled_at?: string | null
          display_name?: string | null
          invite_expires_at?: string | null
          invite_token_hash?: string | null
          invited_at?: string | null
          invited_by?: string | null
          joined_at?: string | null
          role?: string
          user_id: string
        }
        Update: {
          alerts_seen_at?: string | null
          created_at?: string
          digest?: boolean
          disabled_at?: string | null
          display_name?: string | null
          invite_expires_at?: string | null
          invite_token_hash?: string | null
          invited_at?: string | null
          invited_by?: string | null
          joined_at?: string | null
          role?: string
          user_id?: string
        }
        Relationships: []
      }
      platform_saved_views: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
          page: string
          query: string
          shared: boolean
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_id: string
          page: string
          query: string
          shared?: boolean
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
          page?: string
          query?: string
          shared?: boolean
        }
        Relationships: []
      }
      platform_settings: {
        Row: {
          created_at: string
          db_limit_mb: number | null
          grace_days: number
          health_inactive_days: number
          health_setup_days: number
          health_slowing_min_orders: number
          health_slowing_percent: number
          id: number
          setup_fee_discount_ends_at: string | null
          setup_fee_discount_paise: number
          setup_fee_paise: number
          storage_limit_mb: number | null
          support_email: string | null
          support_phone: string | null
          trial_days: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          db_limit_mb?: number | null
          grace_days?: number
          health_inactive_days?: number
          health_setup_days?: number
          health_slowing_min_orders?: number
          health_slowing_percent?: number
          id?: number
          setup_fee_discount_ends_at?: string | null
          setup_fee_discount_paise?: number
          setup_fee_paise?: number
          storage_limit_mb?: number | null
          support_email?: string | null
          support_phone?: string | null
          trial_days?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          db_limit_mb?: number | null
          grace_days?: number
          health_inactive_days?: number
          health_setup_days?: number
          health_slowing_min_orders?: number
          health_slowing_percent?: number
          id?: number
          setup_fee_discount_ends_at?: string | null
          setup_fee_discount_paise?: number
          setup_fee_paise?: number
          storage_limit_mb?: number | null
          support_email?: string | null
          support_phone?: string | null
          trial_days?: number
          updated_at?: string
        }
        Relationships: []
      }
      platform_snoozes: {
        Row: {
          admin_id: string
          created_at: string
          item_key: string
          until: string
        }
        Insert: {
          admin_id: string
          created_at?: string
          item_key: string
          until: string
        }
        Update: {
          admin_id?: string
          created_at?: string
          item_key?: string
          until?: string
        }
        Relationships: []
      }
      platform_tags: {
        Row: {
          colour: string
          created_at: string
          created_by: string | null
          id: string
          name: string
        }
        Insert: {
          colour: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
        }
        Update: {
          colour?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      restaurant_account_managers: {
        Row: {
          created_at: string
          restaurant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          restaurant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          restaurant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "restaurant_account_managers_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: true
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "restaurant_account_managers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "platform_admins"
            referencedColumns: ["user_id"]
          },
        ]
      }
      restaurant_closures: {
        Row: {
          closed_at: string
          closed_by: string | null
          member_ids: string[]
          prior_reason: string | null
          prior_status: Database["public"]["Enums"]["restaurant_status"]
          removal_due_at: string
          removed_at: string | null
          restaurant_id: string
        }
        Insert: {
          closed_at?: string
          closed_by?: string | null
          member_ids: string[]
          prior_reason?: string | null
          prior_status: Database["public"]["Enums"]["restaurant_status"]
          removal_due_at: string
          removed_at?: string | null
          restaurant_id: string
        }
        Update: {
          closed_at?: string
          closed_by?: string | null
          member_ids?: string[]
          prior_reason?: string | null
          prior_status?: Database["public"]["Enums"]["restaurant_status"]
          removal_due_at?: string
          removed_at?: string | null
          restaurant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "restaurant_closures_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: true
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      restaurant_exports: {
        Row: {
          created_at: string
          expires_at: string | null
          finished_at: string | null
          id: string
          requested_by: string | null
          restaurant_id: string
          size_bytes: number | null
          status: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          finished_at?: string | null
          id?: string
          requested_by?: string | null
          restaurant_id: string
          size_bytes?: number | null
          status?: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          finished_at?: string | null
          id?: string
          requested_by?: string | null
          restaurant_id?: string
          size_bytes?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "restaurant_exports_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      restaurant_members: {
        Row: {
          created_at: string
          display_name: string
          id: string
          is_active: boolean
          restaurant_id: string
          role: Database["public"]["Enums"]["member_role"]
          ui_lang: string
          updated_at: string
          user_id: string
          username: string
        }
        Insert: {
          created_at?: string
          display_name: string
          id?: string
          is_active?: boolean
          restaurant_id: string
          role: Database["public"]["Enums"]["member_role"]
          ui_lang?: string
          updated_at?: string
          user_id: string
          username: string
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          is_active?: boolean
          restaurant_id?: string
          role?: Database["public"]["Enums"]["member_role"]
          ui_lang?: string
          updated_at?: string
          user_id?: string
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "restaurant_members_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      restaurant_notes: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          edited_at: string | null
          id: string
          pinned: boolean
          restaurant_id: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          edited_at?: string | null
          id?: string
          pinned?: boolean
          restaurant_id: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          edited_at?: string | null
          id?: string
          pinned?: boolean
          restaurant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "restaurant_notes_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      restaurant_overrides: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          feature: string | null
          id: string
          kind: string
          reason: string
          restaurant_id: string
          updated_at: string
          value: number | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          feature?: string | null
          id?: string
          kind: string
          reason: string
          restaurant_id: string
          updated_at?: string
          value?: number | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          feature?: string | null
          id?: string
          kind?: string
          reason?: string
          restaurant_id?: string
          updated_at?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "restaurant_overrides_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      restaurant_subscriptions: {
        Row: {
          autopay_finished_at: string | null
          billing_cycle: Database["public"]["Enums"]["billing_cycle"] | null
          cancel_at_period_end: boolean
          cancel_reason: string | null
          cancel_reason_detail: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          deal_id: string | null
          effective_monthly_paise: number | null
          grace_until: string | null
          id: string
          next_billing_cycle:
            | Database["public"]["Enums"]["billing_cycle"]
            | null
          next_deal_id: string | null
          next_plan_id: string | null
          plan_id: string
          razorpay_customer_id: string | null
          razorpay_event_at: string | null
          razorpay_status: string | null
          razorpay_subscription_id: string | null
          restaurant_id: string
          source: Database["public"]["Enums"]["subscription_source"] | null
          status: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          autopay_finished_at?: string | null
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"] | null
          cancel_at_period_end?: boolean
          cancel_reason?: string | null
          cancel_reason_detail?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          deal_id?: string | null
          effective_monthly_paise?: number | null
          grace_until?: string | null
          id?: string
          next_billing_cycle?:
            | Database["public"]["Enums"]["billing_cycle"]
            | null
          next_deal_id?: string | null
          next_plan_id?: string | null
          plan_id: string
          razorpay_customer_id?: string | null
          razorpay_event_at?: string | null
          razorpay_status?: string | null
          razorpay_subscription_id?: string | null
          restaurant_id: string
          source?: Database["public"]["Enums"]["subscription_source"] | null
          status: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          autopay_finished_at?: string | null
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"] | null
          cancel_at_period_end?: boolean
          cancel_reason?: string | null
          cancel_reason_detail?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          deal_id?: string | null
          effective_monthly_paise?: number | null
          grace_until?: string | null
          id?: string
          next_billing_cycle?:
            | Database["public"]["Enums"]["billing_cycle"]
            | null
          next_deal_id?: string | null
          next_plan_id?: string | null
          plan_id?: string
          razorpay_customer_id?: string | null
          razorpay_event_at?: string | null
          razorpay_status?: string | null
          razorpay_subscription_id?: string | null
          restaurant_id?: string
          source?: Database["public"]["Enums"]["subscription_source"] | null
          status?: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "restaurant_subscriptions_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "subscription_deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "restaurant_subscriptions_next_deal_id_fkey"
            columns: ["next_deal_id"]
            isOneToOne: false
            referencedRelation: "subscription_deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "restaurant_subscriptions_next_plan_id_fkey"
            columns: ["next_plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "restaurant_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "restaurant_subscriptions_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: true
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      restaurant_tags: {
        Row: {
          created_at: string
          created_by: string | null
          restaurant_id: string
          tag_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          restaurant_id: string
          tag_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          restaurant_id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "restaurant_tags_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "restaurant_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "platform_tags"
            referencedColumns: ["id"]
          },
        ]
      }
      restaurants: {
        Row: {
          accent_color: string
          acquisition_channel: string | null
          address_line: string | null
          bill_footer_text: string | null
          business_day_start_hour: number
          city: string | null
          created_at: string
          customer_cancel_window_seconds: number
          email: string | null
          fssai_license: string | null
          gst_mode: Database["public"]["Enums"]["gst_mode"]
          gst_rate_bps: number
          gstin: string | null
          id: string
          invoice_prefix: string
          legal_name: string | null
          logo_path: string | null
          max_tables_per_waiter: number
          name: string
          paper_width: Database["public"]["Enums"]["paper_width"]
          phone: string | null
          pincode: string | null
          prices_include_tax: boolean
          print_waiter_on_bill: boolean
          reopen_window_minutes: number
          require_first_order_approval: boolean
          service_charge_bps: number
          service_charge_enabled: boolean
          show_upi_qr_on_bill: boolean
          signup_source: Json | null
          slug: string
          staff_can_remove_served_items: boolean
          state: string | null
          status: Database["public"]["Enums"]["restaurant_status"]
          storefront_photo_path: string | null
          suspended_reason: string | null
          timezone: string
          updated_at: string
          upi_payee_name: string | null
          upi_vpa: string | null
        }
        Insert: {
          accent_color?: string
          acquisition_channel?: string | null
          address_line?: string | null
          bill_footer_text?: string | null
          business_day_start_hour?: number
          city?: string | null
          created_at?: string
          customer_cancel_window_seconds?: number
          email?: string | null
          fssai_license?: string | null
          gst_mode?: Database["public"]["Enums"]["gst_mode"]
          gst_rate_bps?: number
          gstin?: string | null
          id?: string
          invoice_prefix?: string
          legal_name?: string | null
          logo_path?: string | null
          max_tables_per_waiter?: number
          name: string
          paper_width?: Database["public"]["Enums"]["paper_width"]
          phone?: string | null
          pincode?: string | null
          prices_include_tax?: boolean
          print_waiter_on_bill?: boolean
          reopen_window_minutes?: number
          require_first_order_approval?: boolean
          service_charge_bps?: number
          service_charge_enabled?: boolean
          show_upi_qr_on_bill?: boolean
          signup_source?: Json | null
          slug: string
          staff_can_remove_served_items?: boolean
          state?: string | null
          status?: Database["public"]["Enums"]["restaurant_status"]
          storefront_photo_path?: string | null
          suspended_reason?: string | null
          timezone?: string
          updated_at?: string
          upi_payee_name?: string | null
          upi_vpa?: string | null
        }
        Update: {
          accent_color?: string
          acquisition_channel?: string | null
          address_line?: string | null
          bill_footer_text?: string | null
          business_day_start_hour?: number
          city?: string | null
          created_at?: string
          customer_cancel_window_seconds?: number
          email?: string | null
          fssai_license?: string | null
          gst_mode?: Database["public"]["Enums"]["gst_mode"]
          gst_rate_bps?: number
          gstin?: string | null
          id?: string
          invoice_prefix?: string
          legal_name?: string | null
          logo_path?: string | null
          max_tables_per_waiter?: number
          name?: string
          paper_width?: Database["public"]["Enums"]["paper_width"]
          phone?: string | null
          pincode?: string | null
          prices_include_tax?: boolean
          print_waiter_on_bill?: boolean
          reopen_window_minutes?: number
          require_first_order_approval?: boolean
          service_charge_bps?: number
          service_charge_enabled?: boolean
          show_upi_qr_on_bill?: boolean
          signup_source?: Json | null
          slug?: string
          staff_can_remove_served_items?: boolean
          state?: string | null
          status?: Database["public"]["Enums"]["restaurant_status"]
          storefront_photo_path?: string | null
          suspended_reason?: string | null
          timezone?: string
          updated_at?: string
          upi_payee_name?: string | null
          upi_vpa?: string | null
        }
        Relationships: []
      }
      service_requests: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          client_device_id: string | null
          created_at: string
          dining_table_id: string
          id: string
          resolved_at: string | null
          resolved_by: string | null
          restaurant_id: string
          session_id: string | null
          status: Database["public"]["Enums"]["service_request_status"]
          type: Database["public"]["Enums"]["service_request_type"]
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          client_device_id?: string | null
          created_at?: string
          dining_table_id: string
          id?: string
          resolved_at?: string | null
          resolved_by?: string | null
          restaurant_id: string
          session_id?: string | null
          status?: Database["public"]["Enums"]["service_request_status"]
          type: Database["public"]["Enums"]["service_request_type"]
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          client_device_id?: string | null
          created_at?: string
          dining_table_id?: string
          id?: string
          resolved_at?: string | null
          resolved_by?: string | null
          restaurant_id?: string
          session_id?: string | null
          status?: Database["public"]["Enums"]["service_request_status"]
          type?: Database["public"]["Enums"]["service_request_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_requests_restaurant_id_dining_table_id_fkey"
            columns: ["restaurant_id", "dining_table_id"]
            isOneToOne: false
            referencedRelation: "dining_tables"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "service_requests_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_requests_restaurant_id_session_id_fkey"
            columns: ["restaurant_id", "session_id"]
            isOneToOne: false
            referencedRelation: "table_sessions"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      session_waiter_assignments: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          created_at: string
          id: string
          restaurant_id: string
          session_id: string
          unassign_reason: Database["public"]["Enums"]["unassign_reason"] | null
          unassigned_at: string | null
          updated_at: string
          waiter_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          created_at?: string
          id?: string
          restaurant_id: string
          session_id: string
          unassign_reason?:
            | Database["public"]["Enums"]["unassign_reason"]
            | null
          unassigned_at?: string | null
          updated_at?: string
          waiter_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          created_at?: string
          id?: string
          restaurant_id?: string
          session_id?: string
          unassign_reason?:
            | Database["public"]["Enums"]["unassign_reason"]
            | null
          unassigned_at?: string | null
          updated_at?: string
          waiter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_waiter_assignments_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_waiter_assignments_restaurant_id_session_id_fkey"
            columns: ["restaurant_id", "session_id"]
            isOneToOne: false
            referencedRelation: "table_sessions"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "session_waiter_assignments_restaurant_id_waiter_id_fkey"
            columns: ["restaurant_id", "waiter_id"]
            isOneToOne: false
            referencedRelation: "waiters"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      site_leads: {
        Row: {
          assignee_id: string | null
          channel: string
          city: string
          created_at: string
          created_by: string | null
          demo_at: string | null
          email: string | null
          follow_up_at: string | null
          id: string
          ip_hash: string | null
          lost_reason: string | null
          message: string | null
          name: string
          phone: string
          plan_code: string | null
          restaurant_id: string | null
          restaurant_name: string
          source: Json | null
          stage: string
          updated_at: string
        }
        Insert: {
          assignee_id?: string | null
          channel?: string
          city: string
          created_at?: string
          created_by?: string | null
          demo_at?: string | null
          email?: string | null
          follow_up_at?: string | null
          id?: string
          ip_hash?: string | null
          lost_reason?: string | null
          message?: string | null
          name: string
          phone: string
          plan_code?: string | null
          restaurant_id?: string | null
          restaurant_name: string
          source?: Json | null
          stage?: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string | null
          channel?: string
          city?: string
          created_at?: string
          created_by?: string | null
          demo_at?: string | null
          email?: string | null
          follow_up_at?: string | null
          id?: string
          ip_hash?: string | null
          lost_reason?: string | null
          message?: string | null
          name?: string
          phone?: string
          plan_code?: string | null
          restaurant_id?: string | null
          restaurant_name?: string
          source?: Json | null
          stage?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "site_leads_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "platform_admins"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "site_leads_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      site_signups: {
        Row: {
          code_hash: string
          created_at: string
          details: Json
          email: string
          expires_at: string
          id: string
          ip_hash: string | null
          sends: number
          tries: number
          verified_at: string | null
        }
        Insert: {
          code_hash: string
          created_at?: string
          details: Json
          email: string
          expires_at?: string
          id?: string
          ip_hash?: string | null
          sends?: number
          tries?: number
          verified_at?: string | null
        }
        Update: {
          code_hash?: string
          created_at?: string
          details?: Json
          email?: string
          expires_at?: string
          id?: string
          ip_hash?: string | null
          sends?: number
          tries?: number
          verified_at?: string | null
        }
        Relationships: []
      }
      standees: {
        Row: {
          cost_paise: number | null
          created_at: string
          created_by: string | null
          delivered_on: string | null
          dispatched_on: string | null
          installed_on: string | null
          notes: string | null
          printed_on: string | null
          quantity: number
          restaurant_id: string
          status: string
          updated_at: string
          vendor: string | null
        }
        Insert: {
          cost_paise?: number | null
          created_at?: string
          created_by?: string | null
          delivered_on?: string | null
          dispatched_on?: string | null
          installed_on?: string | null
          notes?: string | null
          printed_on?: string | null
          quantity: number
          restaurant_id: string
          status?: string
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          cost_paise?: number | null
          created_at?: string
          created_by?: string | null
          delivered_on?: string | null
          dispatched_on?: string | null
          installed_on?: string | null
          notes?: string | null
          printed_on?: string | null
          quantity?: number
          restaurant_id?: string
          status?: string
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "standees_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: true
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_deals: {
        Row: {
          billing_cycle: Database["public"]["Enums"]["billing_cycle"]
          created_at: string
          created_by: string | null
          cycles: number | null
          ended_at: string | null
          id: string
          list_price_paise: number
          offer_id: string | null
          plan_id: string
          price_paise: number
          razorpay_plan_id: string | null
          reason: string | null
          restaurant_id: string
          used_at: string | null
        }
        Insert: {
          billing_cycle: Database["public"]["Enums"]["billing_cycle"]
          created_at?: string
          created_by?: string | null
          cycles?: number | null
          ended_at?: string | null
          id?: string
          list_price_paise: number
          offer_id?: string | null
          plan_id: string
          price_paise: number
          razorpay_plan_id?: string | null
          reason?: string | null
          restaurant_id: string
          used_at?: string | null
        }
        Update: {
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"]
          created_at?: string
          created_by?: string | null
          cycles?: number | null
          ended_at?: string | null
          id?: string
          list_price_paise?: number
          offer_id?: string | null
          plan_id?: string
          price_paise?: number
          razorpay_plan_id?: string | null
          reason?: string | null
          restaurant_id?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscription_deals_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_deals_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_deals_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_payments: {
        Row: {
          amount_paise: number
          base_paise: number | null
          billing_cycle: Database["public"]["Enums"]["billing_cycle"] | null
          created_at: string
          deal_id: string | null
          discount_paise: number | null
          gst_bps: number
          gst_paise: number | null
          id: string
          list_price_paise: number | null
          manual_mode: Database["public"]["Enums"]["manual_payment_mode"] | null
          notes: string | null
          period_end: string | null
          period_start: string | null
          plan_id: string | null
          purpose: string
          razorpay_payment_id: string | null
          recorded_by: string | null
          restaurant_id: string
          source: Database["public"]["Enums"]["subscription_payment_source"]
          updated_at: string
        }
        Insert: {
          amount_paise: number
          base_paise?: number | null
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"] | null
          created_at?: string
          deal_id?: string | null
          discount_paise?: number | null
          gst_bps?: number
          gst_paise?: number | null
          id?: string
          list_price_paise?: number | null
          manual_mode?:
            | Database["public"]["Enums"]["manual_payment_mode"]
            | null
          notes?: string | null
          period_end?: string | null
          period_start?: string | null
          plan_id?: string | null
          purpose?: string
          razorpay_payment_id?: string | null
          recorded_by?: string | null
          restaurant_id: string
          source: Database["public"]["Enums"]["subscription_payment_source"]
          updated_at?: string
        }
        Update: {
          amount_paise?: number
          base_paise?: number | null
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"] | null
          created_at?: string
          deal_id?: string | null
          discount_paise?: number | null
          gst_bps?: number
          gst_paise?: number | null
          id?: string
          list_price_paise?: number | null
          manual_mode?:
            | Database["public"]["Enums"]["manual_payment_mode"]
            | null
          notes?: string | null
          period_end?: string | null
          period_start?: string | null
          plan_id?: string | null
          purpose?: string
          razorpay_payment_id?: string | null
          recorded_by?: string | null
          restaurant_id?: string
          source?: Database["public"]["Enums"]["subscription_payment_source"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_payments_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "subscription_deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_payments_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_payments_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_reminders: {
        Row: {
          due_key: string
          id: string
          kind: string
          restaurant_id: string
          sent_at: string
        }
        Insert: {
          due_key: string
          id?: string
          kind: string
          restaurant_id: string
          sent_at?: string
        }
        Update: {
          due_key?: string
          id?: string
          kind?: string
          restaurant_id?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_reminders_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      support_request_events: {
        Row: {
          actor_id: string | null
          body: string | null
          created_at: string
          from_value: string | null
          id: string
          kind: string
          request_id: string
          restaurant_id: string
          to_value: string | null
        }
        Insert: {
          actor_id?: string | null
          body?: string | null
          created_at?: string
          from_value?: string | null
          id?: string
          kind: string
          request_id: string
          restaurant_id: string
          to_value?: string | null
        }
        Update: {
          actor_id?: string | null
          body?: string | null
          created_at?: string
          from_value?: string | null
          id?: string
          kind?: string
          request_id?: string
          restaurant_id?: string
          to_value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "support_request_events_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "support_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_request_events_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      support_requests: {
        Row: {
          assignee_id: string | null
          contact: string
          contact_method: string
          context: Json
          created_at: string
          created_by: string | null
          created_by_name: string
          created_by_role: Database["public"]["Enums"]["member_role"]
          id: string
          message: string
          priority: string
          resolved_at: string | null
          restaurant_id: string
          screenshot_path: string | null
          status: string
          topic: string
          updated_at: string
        }
        Insert: {
          assignee_id?: string | null
          contact: string
          contact_method: string
          context?: Json
          created_at?: string
          created_by?: string | null
          created_by_name: string
          created_by_role: Database["public"]["Enums"]["member_role"]
          id?: string
          message: string
          priority?: string
          resolved_at?: string | null
          restaurant_id: string
          screenshot_path?: string | null
          status?: string
          topic: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string | null
          contact?: string
          contact_method?: string
          context?: Json
          created_at?: string
          created_by?: string | null
          created_by_name?: string
          created_by_role?: Database["public"]["Enums"]["member_role"]
          id?: string
          message?: string
          priority?: string
          resolved_at?: string | null
          restaurant_id?: string
          screenshot_path?: string | null
          status?: string
          topic?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_requests_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "platform_admins"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "support_requests_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      support_screenshot_uploads: {
        Row: {
          created_at: string
          id: string
          path: string
          restaurant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          path: string
          restaurant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          path?: string
          restaurant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_screenshot_uploads_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      support_sessions: {
        Row: {
          consent: string
          created_at: string
          ended_at: string | null
          ends_at: string
          granted_by: string | null
          id: string
          restaurant_id: string
          staff_name: string | null
          started_at: string | null
          user_id: string | null
        }
        Insert: {
          consent: string
          created_at?: string
          ended_at?: string | null
          ends_at: string
          granted_by?: string | null
          id?: string
          restaurant_id: string
          staff_name?: string | null
          started_at?: string | null
          user_id?: string | null
        }
        Update: {
          consent?: string
          created_at?: string
          ended_at?: string | null
          ends_at?: string
          granted_by?: string | null
          id?: string
          restaurant_id?: string
          staff_name?: string | null
          started_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "support_sessions_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      table_sessions: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          assigned_at: string | null
          assigned_by: string | null
          assigned_waiter_id: string | null
          billed_at: string | null
          close_reason: string | null
          closed_at: string | null
          closed_by: string | null
          created_at: string
          dining_table_id: string
          id: string
          is_approved: boolean
          opened_at: string
          restaurant_id: string
          status: Database["public"]["Enums"]["session_status"]
          table_label_snapshot: string
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          assigned_at?: string | null
          assigned_by?: string | null
          assigned_waiter_id?: string | null
          billed_at?: string | null
          close_reason?: string | null
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          dining_table_id: string
          id?: string
          is_approved?: boolean
          opened_at?: string
          restaurant_id: string
          status?: Database["public"]["Enums"]["session_status"]
          table_label_snapshot: string
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          assigned_at?: string | null
          assigned_by?: string | null
          assigned_waiter_id?: string | null
          billed_at?: string | null
          close_reason?: string | null
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          dining_table_id?: string
          id?: string
          is_approved?: boolean
          opened_at?: string
          restaurant_id?: string
          status?: Database["public"]["Enums"]["session_status"]
          table_label_snapshot?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "table_sessions_restaurant_id_assigned_waiter_id_fkey"
            columns: ["restaurant_id", "assigned_waiter_id"]
            isOneToOne: false
            referencedRelation: "waiters"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "table_sessions_restaurant_id_dining_table_id_fkey"
            columns: ["restaurant_id", "dining_table_id"]
            isOneToOne: false
            referencedRelation: "dining_tables"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "table_sessions_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      trial_claims: {
        Row: {
          created_at: string
          kind: string
          restaurant_id: string
          value: string
        }
        Insert: {
          created_at?: string
          kind: string
          restaurant_id: string
          value: string
        }
        Update: {
          created_at?: string
          kind?: string
          restaurant_id?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "trial_claims_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      waiters: {
        Row: {
          created_at: string
          deleted_at: string | null
          deleted_by: string | null
          employee_code: string | null
          full_name: string
          id: string
          is_active: boolean
          joined_on: string | null
          member_id: string | null
          notes: string | null
          on_duty: boolean
          phone: string | null
          restaurant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          employee_code?: string | null
          full_name: string
          id?: string
          is_active?: boolean
          joined_on?: string | null
          member_id?: string | null
          notes?: string | null
          on_duty?: boolean
          phone?: string | null
          restaurant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          employee_code?: string | null
          full_name?: string
          id?: string
          is_active?: boolean
          joined_on?: string | null
          member_id?: string | null
          notes?: string | null
          on_duty?: boolean
          phone?: string | null
          restaurant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiters_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiters_restaurant_id_member_id_fkey"
            columns: ["restaurant_id", "member_id"]
            isOneToOne: false
            referencedRelation: "restaurant_members"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      webhook_events: {
        Row: {
          created_at: string
          event_id: string
          event_type: string
          id: string
          payload: Json
          processed_at: string | null
          processing_error: string | null
          provider: string
          received_at: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          event_id: string
          event_type: string
          id?: string
          payload: Json
          processed_at?: string | null
          processing_error?: string | null
          provider: string
          received_at?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          event_id?: string
          event_type?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          processing_error?: string | null
          provider?: string
          received_at?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_add_categories: { Args: { p_names: string[] }; Returns: number }
      admin_allow_support_access: { Args: { p_hours: number }; Returns: string }
      admin_assign_waiter: {
        Args: { p_force?: boolean; p_session_id: string; p_waiter_id: string }
        Returns: Json
      }
      admin_billing_sessions: { Args: never; Returns: Json }
      admin_create_category: { Args: { p_name: string }; Returns: string }
      admin_create_staff: {
        Args: { p_actor_user_id: string; p_payload: Json }
        Returns: string
      }
      admin_create_support_request: {
        Args: { p_request: Json }
        Returns: string
      }
      admin_create_tables: { Args: { p_labels: string[] }; Returns: Json }
      admin_data_export: { Args: never; Returns: Json }
      admin_deactivate_staff: {
        Args: { p_member_id: string }
        Returns: undefined
      }
      admin_delete_addon_group: {
        Args: { p_group_id: string }
        Returns: undefined
      }
      admin_delete_category: {
        Args: { p_category_id: string; p_move_to?: string }
        Returns: number
      }
      admin_delete_waiter: { Args: { p_waiter_id: string }; Returns: undefined }
      admin_end_support_access: { Args: never; Returns: undefined }
      admin_generate_bill: {
        Args: {
          p_apply_service_charge: boolean
          p_discount_reason: string
          p_discount_type: Database["public"]["Enums"]["discount_type"]
          p_discount_value: number
          p_expected_grand_total_paise?: number
          p_session_id: string
        }
        Returns: Json
      }
      admin_get_bill: { Args: { p_bill_id: string }; Returns: Json }
      admin_increment_print_count: {
        Args: { p_bill_id: string }
        Returns: Json
      }
      admin_list_staff: {
        Args: never
        Returns: {
          created_at: string
          display_name: string
          is_active: boolean
          last_sign_in_at: string
          member_id: string
          role: Database["public"]["Enums"]["member_role"]
          ui_lang: string
          username: string
          waiter_id: string
          waiter_name: string
        }[]
      }
      admin_list_support_requests: { Args: never; Returns: Json }
      admin_onboarding: { Args: never; Returns: Json }
      admin_preview_bill: {
        Args: {
          p_apply_service_charge: boolean
          p_discount_type: Database["public"]["Enums"]["discount_type"]
          p_discount_value: number
          p_session_id: string
        }
        Returns: Json
      }
      admin_reactivate_staff: {
        Args: { p_member_id: string }
        Returns: undefined
      }
      admin_record_cancel_reason: {
        Args: { p_detail?: string; p_reason: string }
        Returns: undefined
      }
      admin_record_payment: {
        Args: { p_bill_id: string; p_payments: Json }
        Returns: Json
      }
      admin_record_qr_use: {
        Args: { p_action: string; p_table_ids: string[] }
        Returns: undefined
      }
      admin_regenerate_qr: { Args: { p_table_id: string }; Returns: string }
      admin_remove_order: {
        Args: { p_order_id: string; p_reason: string }
        Returns: Json
      }
      admin_reorder: {
        Args: { p_category_id?: string; p_ids: string[]; p_kind: string }
        Returns: undefined
      }
      admin_report_activity: { Args: { p_filters: Json }; Returns: Json }
      admin_report_items: { Args: { p_filters: Json }; Returns: Json }
      admin_report_sales: { Args: { p_filters: Json }; Returns: Json }
      admin_report_tables: { Args: { p_filters: Json }; Returns: Json }
      admin_report_waiters: { Args: { p_filters: Json }; Returns: Json }
      admin_request_data_export: { Args: never; Returns: string }
      admin_reset_staff_password: {
        Args: { p_member_id: string }
        Returns: string
      }
      admin_sample_bill: { Args: never; Returns: Json }
      admin_save_addon_group: { Args: { p_group: Json }; Returns: string }
      admin_save_menu_item: { Args: { p_item: Json }; Returns: string }
      admin_set_waiter_on_duty: {
        Args: { p_on_duty: boolean; p_waiter_id: string }
        Returns: undefined
      }
      admin_start_screenshot_upload: {
        Args: { p_extension: string }
        Returns: string
      }
      admin_total_orders: { Args: { p_filters: Json }; Returns: Json }
      admin_unassign_waiter: { Args: { p_session_id: string }; Returns: Json }
      admin_update_category: {
        Args: { p_category_id: string; p_patch: Json }
        Returns: undefined
      }
      admin_update_menu_item: {
        Args: { p_item_id: string; p_patch: Json }
        Returns: undefined
      }
      admin_update_settings: { Args: { p_patch: Json }; Returns: undefined }
      admin_update_staff: {
        Args: { p_member_id: string; p_patch: Json }
        Returns: undefined
      }
      admin_update_table: {
        Args: { p_patch: Json; p_table_id: string }
        Returns: undefined
      }
      admin_upsert_waiter: { Args: { p_waiter: Json }; Returns: string }
      admin_void_bill: {
        Args: { p_bill_id: string; p_reason: string; p_reopen: boolean }
        Returns: Json
      }
      admin_waiters_overview: {
        Args: never
        Returns: {
          employee_code: string
          full_name: string
          joined_on: string
          member_active: boolean
          member_id: string
          member_username: string
          notes: string
          on_duty: boolean
          open_tables: string[]
          phone: string
          tables_today: number
          waiter_id: string
        }[]
      }
      announcement_email_sent: {
        Args: { p_announcement_id: string; p_restaurant_id: string }
        Returns: undefined
      }
      announcement_emails_due: {
        Args: { p_at?: string }
        Returns: {
          announcement_id: string
          body: string
          recipients: string[]
          restaurant_id: string
          title: string
        }[]
      }
      auth_password_reset_finish: { Args: { p_id: string }; Returns: undefined }
      auth_password_reset_start: {
        Args: { p_code_hash: string; p_email: string; p_ip_hash?: string }
        Returns: Json
      }
      auth_password_reset_verify: {
        Args: { p_code_hash: string; p_id: string }
        Returns: Json
      }
      auth_staff_login_email: {
        Args: { p_slug: string; p_username: string }
        Returns: string
      }
      closed_restaurant_remove_personal_data: {
        Args: { p_restaurant_id: string }
        Returns: Json
      }
      closed_restaurants_due: { Args: { p_limit?: number }; Returns: string[] }
      customer_cancel_item: {
        Args: {
          p_device_id: string
          p_order_item_id: string
          p_qr_token: string
        }
        Returns: Json
      }
      customer_create_service_request: {
        Args: { p_device_id: string; p_qr_token: string; p_type: string }
        Returns: Json
      }
      customer_get_session: {
        Args: { p_device_id?: string; p_qr_token: string }
        Returns: Json
      }
      customer_get_table: { Args: { p_qr_token: string }; Returns: Json }
      customer_place_order: {
        Args: {
          p_device_id: string
          p_idempotency_key: string
          p_items: Json
          p_lang?: string
          p_note?: string
          p_qr_token: string
        }
        Returns: Json
      }
      email_log_cleanup: { Args: never; Returns: number }
      email_log_record_event: {
        Args: { p_provider_id: string; p_type: string }
        Returns: number
      }
      has_role: {
        Args: {
          p_restaurant_id: string
          p_roles: Database["public"]["Enums"]["member_role"][]
        }
        Returns: boolean
      }
      health_check: { Args: never; Returns: string }
      is_platform_admin: { Args: never; Returns: boolean }
      member_announcements: {
        Args: { p_panel: string; p_restaurant_id: string }
        Returns: Json
      }
      member_dismiss_announcement: {
        Args: { p_announcement_id: string }
        Returns: undefined
      }
      member_record_plan_limit: {
        Args: { p_code: string; p_detail?: string }
        Returns: undefined
      }
      member_role: {
        Args: { p_restaurant_id: string }
        Returns: Database["public"]["Enums"]["member_role"]
      }
      member_set_ui_lang: { Args: { p_lang: string }; Returns: undefined }
      menu_hindi_names_claim: {
        Args: { p_limit?: number; p_restaurant_id?: string }
        Returns: {
          id: string
          kind: string
          name: string
          restaurant_id: string
        }[]
      }
      menu_import_claim_page: {
        Args: { p_import_id: string; p_index: number }
        Returns: boolean
      }
      menu_import_commit: {
        Args: {
          p_confirm_food_types?: boolean
          p_draft: Json
          p_import_id: string
        }
        Returns: Json
      }
      menu_import_create: {
        Args: {
          p_page_count: number
          p_restaurant_id: string
          p_source: string
        }
        Returns: Json
      }
      menu_import_discard: { Args: { p_import_id: string }; Returns: undefined }
      menu_import_files_to_remove: {
        Args: { p_limit?: number }
        Returns: {
          file_paths: string[]
          import_id: string
        }[]
      }
      menu_import_mark_files_removed: {
        Args: { p_import_ids: string[] }
        Returns: number
      }
      menu_import_record_page: {
        Args: { p_import_id: string; p_page: Json }
        Returns: Json
      }
      menu_import_set_draft: {
        Args: {
          p_draft?: Json
          p_error?: string
          p_import_id: string
          p_status: string
        }
        Returns: undefined
      }
      menu_set_hindi_names: { Args: { p_names: Json }; Returns: number }
      password_resets_cleanup: { Args: never; Returns: number }
      platform_activity: {
        Args: {
          p_before?: string
          p_kinds?: string[]
          p_limit?: number
          p_restaurant_id?: string
        }
        Returns: Json
      }
      platform_add_lead_note: {
        Args: { p_body: string; p_lead_id: string }
        Returns: string
      }
      platform_add_note: {
        Args: { p_body: string; p_pinned?: boolean; p_restaurant_id: string }
        Returns: string
      }
      platform_add_support_note: {
        Args: { p_body: string; p_request_id: string }
        Returns: string
      }
      platform_admin_status: { Args: never; Returns: string }
      platform_alerts: { Args: never; Returns: Json }
      platform_audit_payment_link: {
        Args: { p_link: Json; p_restaurant_id: string }
        Returns: undefined
      }
      platform_can: { Args: { p_permission: string }; Returns: boolean }
      platform_change_plan: {
        Args: { p_plan_code: string; p_restaurant_id: string }
        Returns: Json
      }
      platform_close_restaurant: {
        Args: { p_code: string; p_reason: string; p_restaurant_id: string }
        Returns: Json
      }
      platform_closure: { Args: { p_restaurant_id: string }; Returns: Json }
      platform_create_lead: { Args: { p_lead: Json }; Returns: string }
      platform_create_restaurant: { Args: { p_payload: Json }; Returns: Json }
      platform_create_tag: {
        Args: { p_colour: string; p_name: string }
        Returns: string
      }
      platform_data_export: { Args: { p_restaurant_id: string }; Returns: Json }
      platform_delete_tag: { Args: { p_tag_id: string }; Returns: undefined }
      platform_delete_view: { Args: { p_id: string }; Returns: undefined }
      platform_digest: { Args: { p_day?: string }; Returns: Json }
      platform_edit_note: {
        Args: { p_body: string; p_note_id: string }
        Returns: undefined
      }
      platform_email_sends: {
        Args: { p_recipient_hash: string }
        Returns: Json
      }
      platform_end_support_session: { Args: never; Returns: undefined }
      platform_extend_trial: {
        Args: { p_days: number; p_restaurant_id: string }
        Returns: Json
      }
      platform_funnel: { Args: { p_from: string; p_to: string }; Returns: Json }
      platform_get_lead: { Args: { p_lead_id: string }; Returns: Json }
      platform_get_restaurant: {
        Args: { p_restaurant_id: string }
        Returns: Json
      }
      platform_get_standees: {
        Args: { p_restaurant_id: string }
        Returns: Json
      }
      platform_get_support_request: {
        Args: { p_request_id: string }
        Returns: Json
      }
      platform_home: { Args: { p_period?: string }; Returns: Json }
      platform_invite_accept: { Args: { p_token_hash: string }; Returns: Json }
      platform_invite_lookup: { Args: { p_token_hash: string }; Returns: Json }
      platform_invite_member: {
        Args: {
          p_display_name: string
          p_role: string
          p_token_hash: string
          p_user_id: string
        }
        Returns: Json
      }
      platform_lead_matches: { Args: { p_phone: string }; Returns: Json }
      platform_list_announcements: { Args: never; Returns: Json }
      platform_list_audit: { Args: { p_filters: Json }; Returns: Json }
      platform_list_dues: { Args: { p_filters: Json }; Returns: Json }
      platform_list_leads: { Args: { p_filters: Json }; Returns: Json }
      platform_list_notes: { Args: { p_restaurant_id: string }; Returns: Json }
      platform_list_offers: { Args: never; Returns: Json }
      platform_list_payments: { Args: { p_filters: Json }; Returns: Json }
      platform_list_restaurants: { Args: { p_filters: Json }; Returns: Json }
      platform_list_standees: {
        Args: { p_page?: number; p_status?: string }
        Returns: Json
      }
      platform_list_subscriptions: { Args: { p_filters: Json }; Returns: Json }
      platform_list_support_requests: {
        Args: { p_filters: Json }
        Returns: Json
      }
      platform_list_team: { Args: never; Returns: Json }
      platform_mark_alerts_seen: { Args: { p_seen: string }; Returns: string }
      platform_metrics_backfill_usage: {
        Args: { p_from: string; p_to: string }
        Returns: number
      }
      platform_metrics_snapshot: { Args: { p_day?: string }; Returns: Json }
      platform_my_access: { Args: never; Returns: Json }
      platform_needs_attention: { Args: never; Returns: Json }
      platform_onboarding_support_session: {
        Args: { p_restaurant_id: string; p_staff_name: string }
        Returns: string
      }
      platform_overview: { Args: never; Returns: Json }
      platform_pin_note: {
        Args: { p_note_id: string; p_pinned: boolean }
        Returns: undefined
      }
      platform_record_manual_payment: {
        Args: { p_payment: Json; p_restaurant_id: string }
        Returns: Json
      }
      platform_record_setup_fee: {
        Args: { p_payment: Json; p_restaurant_id: string }
        Returns: Json
      }
      platform_remove_override: {
        Args: { p_override_id: string }
        Returns: undefined
      }
      platform_renew_invite: {
        Args: { p_token_hash: string; p_user_id: string }
        Returns: Json
      }
      platform_reopen_restaurant: {
        Args: { p_restaurant_id: string }
        Returns: undefined
      }
      platform_reprocess_webhook: {
        Args: { p_event_id: string }
        Returns: Json
      }
      platform_request_data_export: {
        Args: { p_restaurant_id: string }
        Returns: string
      }
      platform_reset_owner_password: {
        Args: { p_member_id: string }
        Returns: string
      }
      platform_restaurant_billing: {
        Args: { p_restaurant_id: string }
        Returns: Json
      }
      platform_restaurant_lookalikes: {
        Args: { p_restaurant_ids: string[] }
        Returns: Json
      }
      platform_restaurant_overview: {
        Args: { p_restaurant_id: string }
        Returns: Json
      }
      platform_restaurant_usage: {
        Args: { p_restaurant_id: string }
        Returns: Json
      }
      platform_revenue_movements: {
        Args: { p_from: string; p_kind: string; p_to: string }
        Returns: Json
      }
      platform_revenue_report: {
        Args: {
          p_by?: string
          p_compare?: boolean
          p_from: string
          p_to: string
        }
        Returns: Json
      }
      platform_save_announcement: {
        Args: { p_announcement: Json; p_announcement_id?: string }
        Returns: Json
      }
      platform_save_offer: {
        Args: { p_offer: Json; p_offer_id?: string }
        Returns: Json
      }
      platform_save_standees: {
        Args: { p_restaurant_id: string; p_standees: Json }
        Returns: Json
      }
      platform_save_view: {
        Args: {
          p_name: string
          p_page: string
          p_query: string
          p_shared: boolean
        }
        Returns: string
      }
      platform_search: { Args: { p_q: string }; Returns: Json }
      platform_set_account_manager: {
        Args: { p_restaurant_id: string; p_user_id: string }
        Returns: undefined
      }
      platform_set_acquisition_channel: {
        Args: { p_channel: string; p_restaurant_id: string }
        Returns: undefined
      }
      platform_set_deal: {
        Args: { p_deal: Json; p_restaurant_id: string }
        Returns: Json
      }
      platform_set_override: {
        Args: { p_override: Json; p_restaurant_id: string }
        Returns: Json
      }
      platform_set_restaurant_status: {
        Args: { p_reason: string; p_restaurant_id: string; p_status: string }
        Returns: Json
      }
      platform_set_restaurant_tags: {
        Args: { p_restaurant_id: string; p_tag_ids: string[] }
        Returns: undefined
      }
      platform_snooze: {
        Args: { p_days: number; p_key: string }
        Returns: string
      }
      platform_start_support_session: {
        Args: { p_restaurant_id: string; p_staff_name: string }
        Returns: string
      }
      platform_support_view: {
        Args: { p_filters?: Json; p_restaurant_id: string; p_section: string }
        Returns: Json
      }
      platform_system: { Args: never; Returns: Json }
      platform_team: { Args: never; Returns: Json }
      platform_unfinished_signups: { Args: never; Returns: Json }
      platform_update_lead: {
        Args: { p_lead_id: string; p_patch: Json }
        Returns: undefined
      }
      platform_update_member: {
        Args: { p_patch: Json; p_user_id: string }
        Returns: Json
      }
      platform_update_plan: {
        Args: { p_patch: Json; p_plan_id: string }
        Returns: Json
      }
      platform_update_settings: { Args: { p_patch: Json }; Returns: Json }
      platform_update_support_request: {
        Args: { p_patch: Json; p_request_id: string }
        Returns: undefined
      }
      platform_upgrade_opportunities: { Args: never; Returns: Json }
      platform_usage_report: {
        Args: { p_compare?: boolean; p_from: string; p_to: string }
        Returns: Json
      }
      razorpay_record_webhook: {
        Args: { p_event_id: string; p_payload: Json }
        Returns: string
      }
      razorpay_save_subscription: {
        Args: {
          p_actor_user_id?: string
          p_cancel_scheduled?: boolean
          p_entity: Json
          p_restaurant_id: string
        }
        Returns: Json
      }
      restaurant_access: {
        Args: { p_at?: string; p_restaurant_id: string }
        Returns: {
          reason: string
          restriction_at: string
          state: string
          warning: string
        }[]
      }
      restaurant_export_finish: {
        Args: { p_export_id: string; p_size_bytes?: number }
        Returns: undefined
      }
      restaurant_exports_to_remove: {
        Args: { p_limit?: number }
        Returns: string[]
      }
      restaurant_plan: {
        Args: { p_restaurant_id: string }
        Returns: {
          features: Json
          max_staff: number
          max_tables: number
          plan_code: string
          plan_name: string
        }[]
      }
      site_create_lead: {
        Args: { p_ip_hash?: string; p_lead: Json }
        Returns: string
      }
      site_signup_create_restaurant: {
        Args: { p_payload: Json }
        Returns: Json
      }
      site_signup_finish: {
        Args: { p_id: string; p_restaurant_id?: string }
        Returns: undefined
      }
      site_signup_identity_taken: {
        Args: { p_fssai: string; p_gstin?: string; p_phone: string }
        Returns: boolean
      }
      site_signup_resend: {
        Args: { p_code_hash: string; p_id: string }
        Returns: string
      }
      site_signup_start: {
        Args: {
          p_code_hash: string
          p_details: Json
          p_email: string
          p_ip_hash?: string
        }
        Returns: string
      }
      site_signup_verify: {
        Args: { p_code_hash: string; p_id: string }
        Returns: Json
      }
      site_signups_cleanup: { Args: never; Returns: number }
      staff_approve_order: { Args: { p_order_id: string }; Returns: Json }
      staff_close_session_unbilled: {
        Args: { p_reason: string; p_session_id: string }
        Returns: Json
      }
      staff_get_board: { Args: never; Returns: Json }
      staff_mark_order_served: { Args: { p_order_id: string }; Returns: Json }
      staff_move_session: {
        Args: { p_session_id: string; p_target_table_id: string }
        Returns: Json
      }
      staff_place_order: {
        Args: {
          p_dining_table_id: string
          p_idempotency_key: string
          p_items: Json
          p_note?: string
        }
        Returns: Json
      }
      staff_reject_order: {
        Args: { p_order_id: string; p_reason: string }
        Returns: Json
      }
      staff_remove_item: {
        Args: { p_order_item_id: string; p_quantity: number; p_reason: string }
        Returns: Json
      }
      staff_revert_item_status: {
        Args: {
          p_from_status: Database["public"]["Enums"]["order_item_status"]
          p_order_item_id: string
        }
        Returns: Json
      }
      staff_set_addon_availability: {
        Args: { p_addon_id: string; p_available: boolean }
        Returns: undefined
      }
      staff_set_item_availability: {
        Args: { p_available: boolean; p_item_id: string }
        Returns: undefined
      }
      staff_update_item_status: {
        Args: {
          p_order_item_id: string
          p_status: Database["public"]["Enums"]["order_item_status"]
        }
        Returns: Json
      }
      staff_update_service_request: {
        Args: { p_request_id: string; p_status: string }
        Returns: Json
      }
      storefront_photos_to_remove: {
        Args: { p_limit?: number }
        Returns: string[]
      }
      subscription_checkout_deal: {
        Args: {
          p_code?: string
          p_cycle: string
          p_plan_code: string
          p_restaurant_id: string
        }
        Returns: Json
      }
      subscription_deal_plan: {
        Args: { p_deal_id: string; p_razorpay_plan_id: string }
        Returns: undefined
      }
      subscription_offer_preview: {
        Args: { p_code?: string; p_restaurant_id: string }
        Returns: Json
      }
      subscription_reminder_sent: {
        Args: { p_due_key: string; p_kind: string; p_restaurant_id: string }
        Returns: boolean
      }
      subscription_reminders_due: {
        Args: { p_at?: string }
        Returns: {
          due_key: string
          ends_at: string
          kind: string
          plan_name: string
          recipients: string[]
          restaurant_id: string
          restaurant_name: string
          restriction_at: string
          timezone: string
          trial_ends_at: string
        }[]
      }
      support_screenshots_to_remove: {
        Args: { p_limit?: number }
        Returns: string[]
      }
      support_sessions_close_expired: { Args: never; Returns: number }
    }
    Enums: {
      actor_type: "staff" | "customer" | "system" | "platform_admin"
      bill_status: "active" | "void"
      billing_cycle: "monthly" | "yearly"
      category_source: "default" | "manual" | "import"
      discount_type: "none" | "flat" | "percent"
      document_type: "tax_invoice" | "bill_of_supply" | "bill"
      food_type: "veg" | "non_veg" | "egg"
      gst_mode: "none" | "regular" | "composition"
      manual_payment_mode: "bank_transfer" | "cash" | "upi" | "cheque"
      member_role: "owner" | "manager" | "waiter" | "kitchen"
      menu_import_source: "photo" | "csv"
      menu_import_status:
        | "uploaded"
        | "processing"
        | "review"
        | "imported"
        | "failed"
        | "discarded"
      order_item_status:
        | "placed"
        | "preparing"
        | "ready"
        | "served"
        | "cancelled"
        | "removed"
      order_placed_via: "customer" | "staff"
      order_status: "pending_approval" | "accepted" | "rejected" | "removed"
      paper_width: "58mm" | "80mm"
      payment_mode: "cash" | "upi" | "card" | "other"
      payment_status: "unpaid" | "paid"
      restaurant_status: "active" | "suspended" | "closed"
      service_request_status: "open" | "acknowledged" | "resolved"
      service_request_type: "call_waiter" | "request_bill"
      session_status: "open" | "billed" | "closed_unbilled"
      subscription_payment_source: "razorpay" | "manual" | "payment_link"
      subscription_source: "razorpay" | "manual"
      subscription_status:
        | "trialing"
        | "active"
        | "past_due"
        | "halted"
        | "cancelled"
        | "expired"
      unassign_reason: "reassigned" | "billed" | "closed_unbilled" | "manual"
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
  public: {
    Enums: {
      actor_type: ["staff", "customer", "system", "platform_admin"],
      bill_status: ["active", "void"],
      billing_cycle: ["monthly", "yearly"],
      category_source: ["default", "manual", "import"],
      discount_type: ["none", "flat", "percent"],
      document_type: ["tax_invoice", "bill_of_supply", "bill"],
      food_type: ["veg", "non_veg", "egg"],
      gst_mode: ["none", "regular", "composition"],
      manual_payment_mode: ["bank_transfer", "cash", "upi", "cheque"],
      member_role: ["owner", "manager", "waiter", "kitchen"],
      menu_import_source: ["photo", "csv"],
      menu_import_status: [
        "uploaded",
        "processing",
        "review",
        "imported",
        "failed",
        "discarded",
      ],
      order_item_status: [
        "placed",
        "preparing",
        "ready",
        "served",
        "cancelled",
        "removed",
      ],
      order_placed_via: ["customer", "staff"],
      order_status: ["pending_approval", "accepted", "rejected", "removed"],
      paper_width: ["58mm", "80mm"],
      payment_mode: ["cash", "upi", "card", "other"],
      payment_status: ["unpaid", "paid"],
      restaurant_status: ["active", "suspended", "closed"],
      service_request_status: ["open", "acknowledged", "resolved"],
      service_request_type: ["call_waiter", "request_bill"],
      session_status: ["open", "billed", "closed_unbilled"],
      subscription_payment_source: ["razorpay", "manual", "payment_link"],
      subscription_source: ["razorpay", "manual"],
      subscription_status: [
        "trialing",
        "active",
        "past_due",
        "halted",
        "cancelled",
        "expired",
      ],
      unassign_reason: ["reassigned", "billed", "closed_unbilled", "manual"],
    },
  },
} as const

