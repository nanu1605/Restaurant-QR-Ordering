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
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
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
      menu_categories: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
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
      order_items: {
        Row: {
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
          created_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          user_id?: string
        }
        Relationships: []
      }
      platform_settings: {
        Row: {
          created_at: string
          grace_days: number
          id: number
          support_email: string | null
          support_phone: string | null
          trial_days: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          grace_days?: number
          id?: number
          support_email?: string | null
          support_phone?: string | null
          trial_days?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          grace_days?: number
          id?: number
          support_email?: string | null
          support_phone?: string | null
          trial_days?: number
          updated_at?: string
        }
        Relationships: []
      }
      restaurant_members: {
        Row: {
          created_at: string
          display_name: string
          id: string
          is_active: boolean
          restaurant_id: string
          role: Database["public"]["Enums"]["member_role"]
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
      restaurant_subscriptions: {
        Row: {
          billing_cycle: Database["public"]["Enums"]["billing_cycle"] | null
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          grace_until: string | null
          id: string
          plan_id: string
          razorpay_customer_id: string | null
          razorpay_subscription_id: string | null
          restaurant_id: string
          source: Database["public"]["Enums"]["subscription_source"] | null
          status: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"] | null
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          grace_until?: string | null
          id?: string
          plan_id: string
          razorpay_customer_id?: string | null
          razorpay_subscription_id?: string | null
          restaurant_id: string
          source?: Database["public"]["Enums"]["subscription_source"] | null
          status: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"] | null
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          grace_until?: string | null
          id?: string
          plan_id?: string
          razorpay_customer_id?: string | null
          razorpay_subscription_id?: string | null
          restaurant_id?: string
          source?: Database["public"]["Enums"]["subscription_source"] | null
          status?: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
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
      restaurants: {
        Row: {
          accent_color: string
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
          slug: string
          staff_can_remove_served_items: boolean
          state: string | null
          status: Database["public"]["Enums"]["restaurant_status"]
          suspended_reason: string | null
          timezone: string
          updated_at: string
          upi_payee_name: string | null
          upi_vpa: string | null
        }
        Insert: {
          accent_color?: string
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
          slug: string
          staff_can_remove_served_items?: boolean
          state?: string | null
          status?: Database["public"]["Enums"]["restaurant_status"]
          suspended_reason?: string | null
          timezone?: string
          updated_at?: string
          upi_payee_name?: string | null
          upi_vpa?: string | null
        }
        Update: {
          accent_color?: string
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
          slug?: string
          staff_can_remove_served_items?: boolean
          state?: string | null
          status?: Database["public"]["Enums"]["restaurant_status"]
          suspended_reason?: string | null
          timezone?: string
          updated_at?: string
          upi_payee_name?: string | null
          upi_vpa?: string | null
        }
        Relationships: []
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
      subscription_payments: {
        Row: {
          amount_paise: number
          created_at: string
          id: string
          manual_mode: Database["public"]["Enums"]["manual_payment_mode"] | null
          notes: string | null
          period_end: string | null
          period_start: string | null
          razorpay_payment_id: string | null
          recorded_by: string | null
          restaurant_id: string
          source: Database["public"]["Enums"]["subscription_payment_source"]
          updated_at: string
        }
        Insert: {
          amount_paise: number
          created_at?: string
          id?: string
          manual_mode?:
            | Database["public"]["Enums"]["manual_payment_mode"]
            | null
          notes?: string | null
          period_end?: string | null
          period_start?: string | null
          razorpay_payment_id?: string | null
          recorded_by?: string | null
          restaurant_id: string
          source: Database["public"]["Enums"]["subscription_payment_source"]
          updated_at?: string
        }
        Update: {
          amount_paise?: number
          created_at?: string
          id?: string
          manual_mode?:
            | Database["public"]["Enums"]["manual_payment_mode"]
            | null
          notes?: string | null
          period_end?: string | null
          period_start?: string | null
          razorpay_payment_id?: string | null
          recorded_by?: string | null
          restaurant_id?: string
          source?: Database["public"]["Enums"]["subscription_payment_source"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_payments_restaurant_id_fkey"
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
      admin_assign_waiter: {
        Args: { p_force?: boolean; p_session_id: string; p_waiter_id: string }
        Returns: Json
      }
      admin_create_category: { Args: { p_name: string }; Returns: string }
      admin_create_staff: {
        Args: { p_actor_user_id: string; p_payload: Json }
        Returns: string
      }
      admin_create_tables: { Args: { p_labels: string[] }; Returns: Json }
      admin_deactivate_staff: {
        Args: { p_member_id: string }
        Returns: undefined
      }
      admin_delete_category: {
        Args: { p_category_id: string; p_move_to?: string }
        Returns: number
      }
      admin_delete_waiter: { Args: { p_waiter_id: string }; Returns: undefined }
      admin_list_staff: {
        Args: never
        Returns: {
          created_at: string
          display_name: string
          is_active: boolean
          last_sign_in_at: string
          member_id: string
          role: Database["public"]["Enums"]["member_role"]
          username: string
          waiter_id: string
          waiter_name: string
        }[]
      }
      admin_reactivate_staff: {
        Args: { p_member_id: string }
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
      admin_reset_staff_password: {
        Args: { p_member_id: string }
        Returns: string
      }
      admin_save_menu_item: { Args: { p_item: Json }; Returns: string }
      admin_set_waiter_on_duty: {
        Args: { p_on_duty: boolean; p_waiter_id: string }
        Returns: undefined
      }
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
      auth_staff_login_email: {
        Args: { p_slug: string; p_username: string }
        Returns: string
      }
      customer_cancel_item: {
        Args: {
          p_device_id: string
          p_order_item_id: string
          p_qr_token: string
        }
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
          p_note?: string
          p_qr_token: string
        }
        Returns: Json
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
      member_role: {
        Args: { p_restaurant_id: string }
        Returns: Database["public"]["Enums"]["member_role"]
      }
      platform_create_restaurant: { Args: { p_payload: Json }; Returns: Json }
      restaurant_access: {
        Args: { p_at?: string; p_restaurant_id: string }
        Returns: {
          reason: string
          restriction_at: string
          state: string
          warning: string
        }[]
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
      staff_approve_order: { Args: { p_order_id: string }; Returns: Json }
      staff_close_session_unbilled: {
        Args: { p_reason: string; p_session_id: string }
        Returns: Json
      }
      staff_get_board: { Args: never; Returns: Json }
      staff_mark_order_served: { Args: { p_order_id: string }; Returns: Json }
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
        Args: { p_order_item_id: string }
        Returns: Json
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
      restaurant_status: "active" | "suspended"
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
      restaurant_status: ["active", "suspended"],
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

