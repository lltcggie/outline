import * as React from "react";
import Tooltip from "~/components/Tooltip";
import type { Props as LocaleTimeProps } from "~/hooks/useLocaleTime";
import { useLocaleTime } from "~/hooks/useLocaleTime";

export type Props = LocaleTimeProps & {
  children?: React.ReactNode;
};

const LocaleTime: React.FC<Props> = ({ children, ...rest }: Props) => {
  const { tooltipContent, content } = useLocaleTime(rest);

  return (
    <Tooltip content={tooltipContent} placement="bottom">
      <time dateTime={rest.dateTime}>{children || content}</time>
    </Tooltip>
  );
};

export default LocaleTime;
