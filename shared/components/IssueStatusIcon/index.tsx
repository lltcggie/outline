import * as React from "react";
import styled from "styled-components";
import type { UnfurlResourceType, UnfurlResponse } from "../../types";
import { isAsanaUrl } from "../../utils/integrations";
import { AsanaIssueStatusIcon } from "./AsanaIssueStatusIcon";
import { DefaultIssueStatusIcon } from "./DefaultIssueStatusIcon";
import { WorkflowStatusIcon } from "./WorkflowStatusIcon";

export type BaseIconProps = {
  state: UnfurlResponse[UnfurlResourceType.Issue]["state"];
  className?: string;
  size?: number;
};

type Props = BaseIconProps & {
  /** The URL of the issue, which decides the icon of trackers with their own. */
  url?: string;
};

/**
 * Renders the status icon of an issue. Asana tasks show whether they are
 * completed, issues with a workflow state type show its progress, others show
 * whether they are open or closed.
 *
 * @param props the issue state and display options.
 * @returns the icon.
 */
export function IssueStatusIcon({ url, ...props }: Props) {
  return (
    <Icon size={props.size} className={props.className}>
      {isAsanaUrl(url) ? (
        <AsanaIssueStatusIcon {...props} />
      ) : props.state.type ? (
        <WorkflowStatusIcon {...props} />
      ) : (
        <DefaultIssueStatusIcon {...props} />
      )}
    </Icon>
  );
}

const Icon = styled.span<{ size?: number }>`
  display: inline-flex;
  flex-shrink: 0;
  width: ${(props) => props.size ?? 24}px;
  height: ${(props) => props.size ?? 24}px;
  align-items: center;
  justify-content: center;
`;
