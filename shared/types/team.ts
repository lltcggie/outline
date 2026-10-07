/** Custom brand colors for a workspace. */
export type CustomTheme = {
  accent: string;
  accentText: string;
};

/** The workspace details that are visible on public shares. */
export type PublicTeam = {
  avatarUrl: string;
  name: string;
  customTheme: Partial<CustomTheme>;
  tocPosition: TOCPosition;
};

/** Positions of the table of contents relative to the document. */
export enum TOCPosition {
  Left = "left",
  Right = "right",
}

/** Who can see user email addresses. */
export enum EmailDisplay {
  None = "none",
  Members = "members",
  Everyone = "everyone",
}

/** Who can comment on documents. */
export enum CommentingAccess {
  /** No one can comment. */
  None = "none",
  /** Only members can comment. */
  Members = "members",
  /** Members and guests can comment. */
  Everyone = "everyone",
}

/** How text with inline comments is highlighted in documents. */
export enum CommentMarkStyle {
  /** A thin underline below the text, filled in on hover. */
  Underline = "underline",
  /** A filled background behind the text with a bottom border. */
  Highlight = "highlight",
}

/** How absolute dates are written out. */
export enum DateFormat {
  /** The long form of the user's language, e.g. "October 7, 2026". */
  Locale = "locale",
  /** Year, month, day separated by hyphens, e.g. "2026-10-07". */
  ISO = "iso",
  /** Year, month, day separated by slashes, e.g. "2026/10/07". */
  YearMonthDay = "yearMonthDay",
  /** Day, month, year separated by slashes, e.g. "07/10/2026". */
  DayMonthYear = "dayMonthYear",
  /** Month, day, year separated by slashes, e.g. "10/07/2026". */
  MonthDayYear = "monthDayYear",
}

/** How times of day are written out. */
export enum TimeFormat {
  /** The convention of the user's language, e.g. "4:15 PM" or "16:15". */
  Locale = "locale",
  /** The 24-hour clock, e.g. "16:15". */
  TwentyFourHour = "24h",
  /** The 12-hour clock with a day period, e.g. "4:15 PM". */
  TwelveHour = "12h",
}

/** Workspace-level preferences. */
export enum TeamPreference {
  /** Whether documents have a separate edit mode instead of always editing. */
  SeamlessEdit = "seamlessEdit",
  /** Whether to use team logo across the app for branding. */
  PublicBranding = "publicBranding",
  /** Whether viewers should see download options. */
  ViewersCanExport = "viewersCanExport",
  /** Whether members can invite new users. */
  MembersCanInvite = "membersCanInvite",
  /** Whether members can create API keys. */
  MembersCanCreateApiKey = "membersCanCreateApiKey",
  /** Whether members can delete their user account. */
  MembersCanDeleteAccount = "membersCanDeleteAccount",
  /** Whether notification emails include document and comment content. */
  PreviewsInEmails = "previewsInEmails",
  /** Who can comment on documents. */
  Commenting = "commenting",
  /** The custom theme for the team. */
  CustomTheme = "customTheme",
  /** Side to display the document's table of contents in relation to the main content. */
  TocPosition = "tocPosition",
  /** Whether to prevent shared documents from being embedded in iframes on external websites. */
  PreventDocumentEmbedding = "preventDocumentEmbedding",
  /** Who can see user email addresses. */
  EmailDisplay = "emailDisplay",
  /** Whether external MCP clients can connect to the workspace. */
  MCP = "mcp",
  /** List of disabled embed provider titles. */
  DisabledEmbeds = "disabledEmbeds",
  /** How text with inline comments is highlighted in documents by default. */
  CommentMarkStyle = "commentMarkStyle",
  /** How absolute dates are written out by default. */
  DateFormat = "dateFormat",
  /** How times of day are written out by default. */
  TimeFormat = "timeFormat",
}

/** Workspace preference values, keyed by preference. */
export type TeamPreferences = {
  [TeamPreference.SeamlessEdit]?: boolean;
  [TeamPreference.PublicBranding]?: boolean;
  [TeamPreference.ViewersCanExport]?: boolean;
  [TeamPreference.MembersCanInvite]?: boolean;
  [TeamPreference.MembersCanCreateApiKey]?: boolean;
  [TeamPreference.MembersCanDeleteAccount]?: boolean;
  [TeamPreference.PreviewsInEmails]?: boolean;
  [TeamPreference.Commenting]?: CommentingAccess;
  [TeamPreference.CustomTheme]?: Partial<CustomTheme>;
  [TeamPreference.TocPosition]?: TOCPosition;
  [TeamPreference.PreventDocumentEmbedding]?: boolean;
  [TeamPreference.EmailDisplay]?: EmailDisplay;
  [TeamPreference.MCP]?: boolean;
  [TeamPreference.DisabledEmbeds]?: string[];
  [TeamPreference.CommentMarkStyle]?: CommentMarkStyle;
  [TeamPreference.DateFormat]?: DateFormat;
  [TeamPreference.TimeFormat]?: TimeFormat;
};
