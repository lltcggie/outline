import type { BaseIconProps } from ".";

/**
 * The completion state of an Asana task, as the check mark shown in Asana: an
 * outlined circle while the task is incomplete and a filled one once it is
 * completed.
 *
 * @param props the state of the task and the size of the icon.
 * @returns the icon as an SVG element.
 */
export function AsanaIssueStatusIcon(props: BaseIconProps) {
  const { state, className, size = 16 } = props;
  const completed = state.type === "completed";

  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      className={className}
    >
      <circle
        cx="8"
        cy="8"
        r="6.75"
        fill={completed ? state.color : "none"}
        stroke={state.color}
        strokeWidth="1.5"
      />
      <path
        d="M4.75 8.25 7 10.5l4.25-4.5"
        stroke={completed ? "#fff" : state.color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
