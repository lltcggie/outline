import { observer } from "mobx-react";
import {
  DocumentIcon,
  EmailIcon,
  CollectionIcon,
  LinkIcon,
} from "outline-icons";
import type { Node } from "prosemirror-model";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import styled from "styled-components";
import {
  dateToRelativeReadable,
  hasTimeComponent,
  parseISODate,
} from "../../utils/date";
import { Backticks } from "../../components/Backticks";
import Flex from "../../components/Flex";
import Icon from "../../components/Icon";
import { IssueStatusIcon } from "../../components/IssueStatusIcon";
import { PullRequestIcon } from "../../components/PullRequestIcon";
import Spinner from "../../components/Spinner";
import Text from "../../components/Text";
import useStores from "../../hooks/useStores";
import useShare from "../../hooks/useShare";
import env from "../../env";
import {
  MentionDisplay,
  UnfurlResourceType,
  type JSONValue,
  type UnfurlResponse,
} from "../../types";
import { cn } from "../styles/utils";
import type { ComponentProps } from "../types";
import lazyWithRetry from "../../utils/lazyWithRetry";
import { sharedModelPath } from "../../utils/routeHelpers";
import { toDisplayUrl, sanitizeImageSrc } from "../../utils/urls";
import Squircle from "../../components/Squircle";
import { LinkCard, MentionCard } from "./MentionCard";
import { ProsemirrorDataHelper } from "../../utils/ProsemirrorDataHelper";

type Attrs = {
  className: string;
} & Record<string, JSONValue>;

/**
 * Returns mention attributes with the selection class applied.
 *
 * @param node the mention node.
 * @param isSelected whether the mention is selected.
 * @returns the attributes for the rendered mention.
 */
const getAttributesFromNode = (node: Node, isSelected = false): Attrs => {
  const spec = node.type.spec.toDOM?.(node) as unknown as Record<
    string,
    JSONValue
  >[];
  const { class: className, ...attrs } = spec[1];

  return {
    className: cn(typeof className === "string" ? className : undefined, {
      "ProseMirror-selectednode": isSelected,
    }),
    ...attrs,
  };
};

/**
 * Returns a hook that scopes an internal model path to the current public share,
 * if any, so that navigation stays within the share rather than falling through
 * to the authenticated app (and its login screen).
 */
const useSharePath = () => {
  const { shareId } = useShare();

  return React.useCallback(
    (path: string) =>
      shareId ? sharedModelPath(shareId, path, env.ROOT_SHARE_ID) : path,
    [shareId]
  );
};

export const MentionUser = observer(function MentionUser_(
  props: ComponentProps
) {
  const { isSelected, node } = props;
  const { users } = useStores();
  const user = users.get(node.attrs.modelId);
  const { className, ...attrs } = getAttributesFromNode(node, isSelected);

  return (
    <span {...attrs} className={className}>
      <EmailIcon size={18} />
      <span>{user?.name || node.attrs.label}</span>
    </span>
  );
});

export const MentionGroup = observer(function MentionGroup_(
  props: ComponentProps
) {
  const { isSelected, node } = props;
  const { groups } = useStores();
  const group = groups.get(node.attrs.modelId);
  const { className, ...attrs } = getAttributesFromNode(node, isSelected);

  return (
    <span {...attrs} className={className}>
      <EmailIcon size={18} />
      <span>{group?.name || node.attrs.label}</span>
    </span>
  );
});

export const MentionDocument = observer(function MentionDocument_(
  props: ComponentProps
) {
  const { isSelected, node } = props;
  const { t } = useTranslation();
  const { documents, collections, unfurls } = useStores();
  const doc = documents.get(node.attrs.modelId);
  const modelId = node.attrs.modelId;
  const anchorId = node.attrs.anchorId;
  const isCard = node.attrs.display === MentionDisplay.Card;
  const { className, ...attrs } = getAttributesFromNode(node, isSelected);
  const sharePath = useSharePath();
  const { shareId } = useShare();
  const hash = anchorId ? `#${anchorId}` : "";

  // The summary is specific to the viewer, so it is kept in the store and not
  // written to the node. The share id is always included, even for a root
  // share, so that the server can check access through the share.
  const unfurlUrl = isCard
    ? `${env.URL}${shareId ? `/s/${shareId}` : ""}/doc/${modelId}${hash}`
    : undefined;

  React.useEffect(() => {
    if (modelId) {
      void documents.prefetchDocument(modelId);
    }
  }, [modelId, documents]);

  React.useEffect(() => {
    if (unfurlUrl) {
      void unfurls.fetchUnfurl({ url: unfurlUrl });
    }
  }, [unfurlUrl, unfurls]);

  const documentPath = sharePath(doc?.path ?? `/doc/${node.attrs.modelId}`);
  const icon = doc?.icon ? (
    <Icon value={doc.icon} initial={doc.initial} color={doc.color} size={18} />
  ) : (
    <DocumentIcon size={18} />
  );
  const title = doc?.title || node.attrs.label;

  if (isCard) {
    const documentUnfurl = unfurlUrl ? unfurls.get(unfurlUrl)?.data : undefined;
    const isDocumentUnfurl =
      documentUnfurl?.type === UnfurlResourceType.Document;
    const collection = doc?.collectionId
      ? collections.get(doc.collectionId)
      : undefined;

    return (
      <Link
        {...attrs}
        className={className}
        to={`${documentPath}${hash}`}
        contentEditable={false}
      >
        <MentionCard
          icon={icon}
          title={title}
          description={isDocumentUnfurl ? documentUnfurl.summary : undefined}
          thumbnailUrl={
            isDocumentUnfurl ? documentUnfurl.thumbnailUrl : undefined
          }
          titleSuffix={
            collection
              ? t("in {{ collectionName }}", {
                  collectionName: collection.name,
                })
              : undefined
          }
        />
      </Link>
    );
  }

  return (
    <Link {...attrs} className={className} to={`${documentPath}${hash}`}>
      {icon}
      <span>{title}</span>
    </Link>
  );
});

export const MentionCollection = observer(function MentionCollection_(
  props: ComponentProps
) {
  const { isSelected, node } = props;
  const { collections } = useStores();
  const collection = collections.get(node.attrs.modelId);
  const modelId = node.attrs.modelId;
  const { className, ...attrs } = getAttributesFromNode(node, isSelected);
  const sharePath = useSharePath();

  React.useEffect(() => {
    if (modelId) {
      void collections.fetch(modelId);
    }
  }, [modelId, collections]);

  const icon = collection?.icon ? (
    <Icon
      value={collection.icon}
      initial={collection.initial}
      color={collection.color}
      size={18}
    />
  ) : (
    <CollectionIcon size={18} />
  );
  const title = collection?.title || node.attrs.label;
  const to = sharePath(collection?.path ?? `/collection/${node.attrs.modelId}`);

  if (node.attrs.display === MentionDisplay.Card) {
    return (
      <Link {...attrs} className={className} to={to} contentEditable={false}>
        <MentionCard
          icon={icon}
          title={title}
          description={
            collection?.data
              ? ProsemirrorDataHelper.getFirstText(collection.data)
              : undefined
          }
        />
      </Link>
    );
  }

  return (
    <Link {...attrs} className={className} to={to}>
      {icon}
      <span>{title}</span>
    </Link>
  );
});

// Unfurled data is fetched with the viewer's own access and only kept in the
// client store. Nodes are never changed while they are displayed, so nothing
// the viewer can see is written back to the document. The mention type is
// decided when the mention is created.

/**
 * Fetches the unfurl of an external mention with the viewer's own access.
 *
 * @param href the url of the mention.
 * @param type the resource type the unfurl must have to be returned, any type
 * is accepted when omitted.
 * @returns the unfurled data, if any, and whether the fetch has completed.
 */
function useMentionUnfurl(
  href: JSONValue | undefined,
  type?: UnfurlResourceType
) {
  const { unfurls } = useStores();
  const [loaded, setLoaded] = React.useState(false);

  const url = typeof href === "string" ? href : undefined;
  const unfurlModel = url ? unfurls.get(url) : undefined;
  const unfurl =
    unfurlModel && (!type || unfurlModel.type === type)
      ? unfurlModel.data
      : undefined;

  React.useEffect(() => {
    if (!url) {
      return;
    }

    // The node view may be destroyed before the fetch resolves, in which case
    // its state must not be updated.
    let cancelled = false;

    // Nothing is added to the store when the url cannot be unfurled, as it is
    // shared with other mentions of the same url, which may be of a different
    // type. The mention is then displayed as a plain link.
    const fetchUnfurl = async () => {
      await unfurls.fetchUnfurl({ url });

      if (!cancelled) {
        setLoaded(true);
      }
    };

    void fetchUnfurl();

    return () => {
      cancelled = true;
    };
  }, [unfurls, url]);

  // Without a url there is nothing to fetch.
  return { unfurl, loaded: loaded || !url };
}

export const MentionURL = observer((props: ComponentProps) => {
  const { isSelected, node } = props;
  const { className, ...attrs } = getAttributesFromNode(node, isSelected);
  const { unfurl, loaded } = useMentionUnfurl(attrs.href);
  const url = typeof attrs.href === "string" ? attrs.href : undefined;

  // A card that cannot be unfurled with the viewer's access shows its URL.
  if (node.attrs.display === MentionDisplay.Card && (unfurl || loaded)) {
    return (
      <LinkCard
        {...attrs}
        className={className}
        url={url}
        unfurl={unfurl ?? {}}
      />
    );
  }

  if (!unfurl) {
    return (
      <MentionFallback loaded={loaded} className={className} attrs={attrs} />
    );
  }

  return (
    <a
      {...attrs}
      className={className}
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
    >
      <Flex align="center" gap={6}>
        {unfurl.faviconUrl ? (
          <Logo src={sanitizeImageSrc(unfurl.faviconUrl)} alt="" />
        ) : null}
        <Text>
          {/* The resource may turn out to be an issue or project, which are
          displayed as a plain url mention as the type is never changed. */}
          <Backticks
            content={
              unfurl.title ?? unfurl.name ?? toDisplayUrl(attrs.href as string)
            }
          />
        </Text>
      </Flex>
    </a>
  );
});

export const MentionIssue = observer((props: ComponentProps) => {
  const { isSelected, node } = props;
  const { className, ...attrs } = getAttributesFromNode(node, isSelected);
  const { unfurl, loaded } = useMentionUnfurl(
    attrs.href,
    UnfurlResourceType.Issue
  );

  if (!unfurl) {
    return (
      <MentionFallback loaded={loaded} className={className} attrs={attrs} />
    );
  }

  const issue = unfurl as UnfurlResponse[UnfurlResourceType.Issue];

  return (
    <a
      {...attrs}
      className={className}
      href={attrs.href as string}
      target="_blank"
      rel="noopener noreferrer nofollow"
    >
      <Flex align="center" gap={6}>
        <IssueStatusIcon size={14} state={issue.state} />
        <Flex align="center" gap={4}>
          <Text>
            <Backticks content={issue.title} />
          </Text>
          <Text type="tertiary">{issue.id}</Text>
        </Flex>
      </Flex>
    </a>
  );
});

export const MentionProject = observer((props: ComponentProps) => {
  const { isSelected, node } = props;
  const { className, ...attrs } = getAttributesFromNode(node, isSelected);
  const { unfurl, loaded } = useMentionUnfurl(
    attrs.href,
    UnfurlResourceType.Project
  );

  if (!unfurl) {
    return (
      <MentionFallback loaded={loaded} className={className} attrs={attrs} />
    );
  }

  const project = unfurl as UnfurlResponse[UnfurlResourceType.Project];

  return (
    <a
      {...attrs}
      className={className}
      href={attrs.href as string}
      target="_blank"
      rel="noopener noreferrer nofollow"
    >
      <Flex align="center" gap={6}>
        {project.avatarUrl ? (
          <ProjectAvatar src={sanitizeImageSrc(project.avatarUrl)} alt="" />
        ) : (
          <Squircle color={project.color} size={12} />
        )}
        <Flex align="center" gap={4}>
          <Text>
            <Backticks content={project.name} />
          </Text>
          <Text type="tertiary">
            {project.progress !== undefined
              ? `${Math.round(project.progress * 100)}%`
              : project.id}
          </Text>
        </Flex>
      </Flex>
    </a>
  );
});

export const MentionPullRequest = observer((props: ComponentProps) => {
  const { isSelected, node } = props;
  const { className, ...attrs } = getAttributesFromNode(node, isSelected);
  const { unfurl, loaded } = useMentionUnfurl(
    attrs.href,
    UnfurlResourceType.PR
  );

  if (!unfurl) {
    return (
      <MentionFallback loaded={loaded} className={className} attrs={attrs} />
    );
  }

  const pullRequest = unfurl as UnfurlResponse[UnfurlResourceType.PR];

  return (
    <a
      {...attrs}
      className={className}
      href={attrs.href as string}
      target="_blank"
      rel="noopener noreferrer nofollow"
    >
      <Flex align="center" gap={6}>
        <PullRequestIcon size={14} state={pullRequest.state} />
        <Flex align="center" gap={4}>
          <Text>
            <Backticks content={pullRequest.title} />
          </Text>
          <Text type="tertiary">{pullRequest.id}</Text>
        </Flex>
      </Flex>
    </a>
  );
});

type DateProps = ComponentProps & {
  onChangeDate: (modelId: string) => void;
};

// Loaded lazily so its browser-only dependencies (Radix, react-day-picker)
// don't enter the editor schema's static import graph, which is also used on
// the server.
const DateMentionPicker = lazyWithRetry(() => import("./DateMentionPicker"));

export const MentionDate = observer(function MentionDate_(props: DateProps) {
  const { isSelected, isEditable, node, onChangeDate } = props;
  const { t } = useTranslation();
  const { auth } = useStores();
  const { className, ...attrs } = getAttributesFromNode(node, isSelected);

  const language = auth.user?.language;
  const iso = typeof node.attrs.modelId === "string" ? node.attrs.modelId : "";
  const display = dateToRelativeReadable(iso, t, language);
  const selectedDate = parseISODate(iso) ?? undefined;

  const content = (
    <DateMention {...attrs} className={className} $editable={isEditable}>
      {display}
    </DateMention>
  );

  if (!isEditable) {
    return content;
  }

  return (
    <React.Suspense fallback={content}>
      <DateMentionPicker
        selectedDate={selectedDate}
        includeTime={hasTimeComponent(iso)}
        language={language}
        onChange={onChangeDate}
      >
        {content}
      </DateMentionPicker>
    </React.Suspense>
  );
});

interface ExternalMentionProps {
  /** The class names of the mention node, including its selection state. */
  className: string;
  /** The other DOM attributes of the mention node. */
  attrs: Record<string, JSONValue>;
}

/**
 * Displays an external mention while its unfurl is being fetched, or as a
 * plain link once it is known that it cannot be unfurled.
 */
const MentionFallback = ({
  loaded,
  ...props
}: ExternalMentionProps & { loaded: boolean }) =>
  loaded ? (
    <MentionLink {...props} />
  ) : (
    <MentionLoading className={props.className} />
  );

const MentionLoading = ({ className }: { className: string }) => {
  const { t } = useTranslation();

  return (
    <span className={className}>
      <Spinner />
      <Text type="tertiary">{`${t("Loading")}…`}</Text>
    </span>
  );
};

/**
 * Displays an external mention that could not be unfurled with the viewer's
 * access as a plain link to its URL, revealing nothing about the resource.
 */
const MentionLink = ({ className, attrs }: ExternalMentionProps) => {
  const { t } = useTranslation();
  const href = typeof attrs.href === "string" ? attrs.href : undefined;

  return (
    <a
      {...attrs}
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
    >
      <Flex align="center" gap={6}>
        <LinkIcon size={18} />
        {/* Without a URL the label is not shown, it may be the title of the
        resource written by an earlier version. The same text as the label
        persisted by ProsemirrorDataHelper.getCleanedMentionAttrs is shown. */}
        <Text>{href ? toDisplayUrl(href) : t("Unavailable link")}</Text>
      </Flex>
    </a>
  );
};

const DateMention = styled.span<{ $editable: boolean }>`
  cursor: ${(props) => (props.$editable ? "pointer" : "default")};
  user-select: none;
`;

const Logo = styled.img`
  width: 16px;
  height: 16px;
`;

const ProjectAvatar = styled.img`
  width: 12px;
  height: 12px;
  border-radius: 2px;
`;
