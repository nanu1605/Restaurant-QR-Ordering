/** The super-admin permissions (docs/SUPER_ADMIN_PLAN.md §3), checked again in SQL. */
export type PlatformPermission =
  | 'restaurants.view'
  | 'restaurants.manage'
  | 'restaurants.support'
  | 'restaurants.close'
  | 'money.view'
  | 'money.record'
  | 'growth.manage'
  | 'insights.view'
  | 'settings.manage'
  | 'team.manage'
  | 'system.view'
  | 'audit.view';
