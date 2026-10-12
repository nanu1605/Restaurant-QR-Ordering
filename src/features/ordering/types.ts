import type { FoodType } from '@/components/shared/food-type-mark';
import type { OrderItemStatus } from '@/lib/order-status';
import type { Database } from '@/types/database';

/** What customers see of a table and its menu (customer_get_table). */

export type CustomerVariant = { id: string; name: string; pricePaise: number };

export type CustomerAddon = { id: string; name: string; pricePaise: number; isAvailable: boolean };

/** A shared add-on group, e.g. "Toppings: up to 3" (docs/DECISIONS.md P9-4). */
export type CustomerAddonGroup = {
  id: string;
  name: string;
  /** 0 = optional. */
  minSelect: number;
  maxSelect: number;
  addons: CustomerAddon[];
};

export type CustomerMenuItem = {
  id: string;
  /** In Hindi, the restaurant's Hindi name when it has one. */
  name: string;
  /** The typed name when a Hindi name is shown, so search finds either. */
  altName?: string;
  description: string | null;
  foodType: FoodType;
  /** With options, the cheapest option ("from ₹X"). */
  pricePaise: number;
  imageUrl: string | null;
  /** Out of stock; on the customer menu also when a required add-on group has too little in stock. */
  isAvailable: boolean;
  variants: CustomerVariant[];
  /** The dish's add-on groups in order (shared objects: one group serves many dishes). */
  addonGroups: CustomerAddonGroup[];
};

export type CustomerCategory = {
  id: string;
  name: string;
  altName?: string;
  items: CustomerMenuItem[];
};

export type CustomerTable = {
  restaurant: {
    name: string;
    logoUrl: string | null;
    accentColor: string;
    timezone: string;
  };
  tableLabel: string;
  /** False while the restaurant is read-only: the menu is view-only (spec §10.6). */
  canOrder: boolean;
  requireApproval: boolean;
  cancelWindowSeconds: number;
  menu: CustomerCategory[];
  /** Rounds in the table's open session, or null while the table is free. */
  sessionOrderCount: number | null;
};

/** The table's open session for the orders page (customer_get_session). */

export type OrderStatus = Database['public']['Enums']['order_status'];

export type CustomerOrderItem = {
  id: string;
  name: string;
  variant: string | null;
  addons: string[];
  foodType: FoodType;
  quantity: number;
  unitPricePaise: number;
  note: string | null;
  status: OrderItemStatus;
  removedReason: string | null;
  /** Set while this phone may still cancel the dish. */
  cancellableUntil: string | null;
};

export type CustomerRound = {
  id: string;
  roundNumber: number;
  status: OrderStatus;
  placedAt: string;
  isMine: boolean;
  customerNote: string | null;
  rejectReason: string | null;
  removedReason: string | null;
  items: CustomerOrderItem[];
};

export type CustomerSessionView = {
  /** Server clock, so countdowns don't depend on the phone's clock. */
  now: string;
  timezone: string;
  cancelWindowSeconds: number;
  canOrder: boolean;
  /** This phone's last session here was billed within the hour (spec §9.3). */
  lastSessionBilled: boolean;
  /**
   * That session's bill, unless voided. The orders page draws the bill itself on the server
   * (docs/DECISIONS.md P11-2); a poll that brings a different one refreshes the page.
   */
  bill: { invoiceNumber: string; paid: boolean } | null;
  /** Rounds of the open session, or null while the table is free. */
  rounds: CustomerRound[] | null;
};
