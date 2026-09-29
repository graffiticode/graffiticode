// SPDX-License-Identifier: MIT
// Ported from L0158 packages/api/src/author.js.
import { v4 as uuid } from "uuid";

export const buildInitAuthor = ({
  sdk,
  key,
  secret,
  domain,
}: any) => async ({ data, mode = "item_edit", widgetTypes, customWidgets }: any, { key: optKey, secret: optSecret }: any = {}) => {
  const user_id = uuid();
  const consumer = {
    consumer_key: optKey ?? key,
    domain,
    user_id,
  };

  // The widget types the Author Site offers. Taken from Learnosity's question-type
  // catalog: `fillintheblanks`, `clozeinlinetext` and `highlighttext` were in this
  // list and name no Learnosity type at all, and `longtext`, `formula`,
  // `imageclozeassociation` and `sortlist` named deprecated ones (sortlist cannot
  // be newly authored from v2026.1.LTS). Types L0176 itself emits are listed first.
  const allowedWidgetTypes = widgetTypes || [
    // emitted by L0176
    "mcq",
    "shorttext",
    "longtextV2",
    "plaintext",
    "clozetext",
    "clozeassociation",
    "clozedropdown",
    "clozeformulaV2",
    "choicematrix",
    "orderlist",
    "classification",
    "bowtie",
    "tokenhighlight",
    // authorable in the Author Site, not yet in L0176's vocabulary
    "association",
    "graphplotting",
    "hotspot",
    "imageclozeassociationV2",
    "imageclozetext",
    "numberline",
  ];


  const requestData: any = {
    mode,
    config: {
      dependencies: {
        questions_api: {
          init_options: {
            widgetTypes: allowedWidgetTypes,
          },
        },
      },
      widget_templates: {
        filter: widgetTypes ? {
          widgettype: widgetTypes,
        } : undefined,
        custom: customWidgets || [],
      },
      item_edit: {
        item: {
          reference: data?.reference,
          dynamic_content: true,
          shared_passage: true,
          features: true,
          tags: {
            show: true,
            edit: true,
          },
        },
        widget: {
          delete: true,
          edit: true,
        },
        widget_types: {
          show: true,
          enabled: allowedWidgetTypes,
        },
      },
      item_list: {
        filter: {
          restricted: {
            current_user: false,
          },
        },
        toolbar: {
          add: true,
          browse: true,
        },
      },
    },
    user: {
      id: user_id,
      firstname: "Author",
      lastname: "User",
    },
  };

  if (data) {
    Object.assign(requestData, data);
  }

  const signedRequest = sdk.init(
    "author",
    consumer,
    optSecret ?? secret,
    requestData,
  );
  return signedRequest;
};

// Unlike createItems and createQuestions this one neither signs nor calls the
// Data API — it returns the plain author-config object, and `buildInitAuthor`
// signs it later — so it takes no dependencies. The argument is accepted and
// ignored to keep the call site uniform with its siblings.
export const buildCreateAuthor = (_deps?: any) => async ({
  mode = "item_edit",
  reference,
  id,
  config = {},
  organisation_id,
  user = {
    id: uuid(),
    firstname: "Author",
    lastname: "User",
  },
}: any) => {
  const itemRef = reference || `artcompiler-author-${id || uuid()}`;

  return {
    type: "author",
    data: {
      mode,
      reference: itemRef,
      config,
      organisation_id,
      user,
    },
  };
};
