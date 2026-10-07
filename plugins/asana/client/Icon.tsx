type Props = {
  /** The size of the icon, 24px is default to match standard icons */
  size?: number;
  /** The color of the icon, defaults to the current text color */
  fill?: string;
  /** Whether to render the monochrome version, defaults to true */
  monochrome?: boolean;
};

/**
 * The Asana logo, three dots in a triangle.
 *
 * @param props the size and color of the icon.
 * @returns the icon as an SVG element.
 */
export function AsanaIcon({
  size = 24,
  fill = "currentColor",
  monochrome = true,
}: Props) {
  const color = monochrome ? fill : "#F06A6A";

  return (
    <svg
      fill={color}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="7.25" r="4.25" />
      <circle cx="6.5" cy="16.75" r="4.25" />
      <circle cx="17.5" cy="16.75" r="4.25" />
    </svg>
  );
}
