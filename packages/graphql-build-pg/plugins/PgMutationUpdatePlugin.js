const queryFromResolveData = require("../queryFromResolveData");
const {
  GraphQLNonNull,
  GraphQLInputObjectType,
  GraphQLString,
  GraphQLObjectType,
  GraphQLID,
} = require("graphql");
const debugSql = require("debug")("graphql-build-pg:sql");
const debug = require("debug")("graphql-build-pg");
const base64Decode = str => Buffer.from(String(str), "base64").toString("utf8");
const camelcase = require("lodash/camelcase");
const pluralize = require("pluralize");

module.exports = async function PgMutationUpdateRowByUniqueConstraintPlugin(
  builder,
  { pgInflection: inflection }
) {
  builder.hook(
    "GraphQLObjectType:fields",
    (
      fields,
      {
        buildObjectWithHooks,
        getNodeIdForTypeAndIdentifiers,
        nodeIdFieldName,
        extend,
        parseResolveInfo,
        getTypeByName,
        gql2pg,
        pgIntrospectionResultsByKind: introspectionResultsByKind,
        pgSql: sql,
        pgGqlInputTypeByTypeId: gqlInputTypeByTypeId,
        getNodeType,
      },
      { scope: { isRootMutation }, buildFieldWithHooks }
    ) => {
      if (!isRootMutation) {
        return fields;
      }
      return extend(
        fields,
        ["update", "delete"].reduce(
          (outerMemo, mode) =>
            introspectionResultsByKind.class.reduce((memo, table) => {
              const TableType = getTypeByName(
                inflection.tableType(table.name, table.namespace.name)
              );
              if (TableType) {
                const uniqueConstraints = introspectionResultsByKind.constraint
                  .filter(con => con.classId === table.id)
                  .filter(con => ["u", "p"].includes(con.type));
                const attributes = introspectionResultsByKind.attribute
                  .filter(attr => attr.classId === table.id)
                  .sort((a, b) => a.num - b.num);
                const Table = getTypeByName(
                  inflection.tableType(table.name, table.namespace.name)
                );
                const TablePatch = getTypeByName(
                  inflection.patchType(Table.name)
                );
                const PayloadType = buildObjectWithHooks(
                  GraphQLObjectType,
                  {
                    name: inflection[
                      mode === "delete"
                        ? "deletePayloadType"
                        : "updatePayloadType"
                    ](table.name, table.namespace.name),
                    fields: ({ recurseDataGeneratorsForField }) => {
                      const tableName = inflection.tableName(
                        table.name,
                        table.namespace.name
                      );
                      recurseDataGeneratorsForField(tableName);
                      return Object.assign(
                        {
                          clientMutationId: {
                            type: GraphQLString,
                            resolve(data) {
                              return data.__clientMutationId;
                            },
                          },
                          [tableName]: {
                            type: Table,
                            resolve(data) {
                              return data.data;
                            },
                          },
                        },
                        mode === "delete" && {
                          [camelcase(`deleted-${table.name}-id`)]: {
                            type: GraphQLID,
                            resolve(data) {
                              return (
                                data.data.__identifiers &&
                                getNodeIdForTypeAndIdentifiers(
                                  Table,
                                  ...data.data.__identifiers
                                )
                              );
                            },
                          },
                        }
                      );
                    },
                  },
                  {
                    isMutationPayload: true,
                    isPgUpdatePayloadType: mode === "update",
                    isPgDeletePayloadType: mode === "delete",
                    pgIntrospection: table,
                  }
                );

                async function commonCodeRenameMe(
                  pgClient,
                  resolveInfo,
                  getDataFromParsedResolveInfoFragment,
                  PayloadType,
                  input,
                  condition
                ) {
                  const parsedResolveInfoFragment = parseResolveInfo(
                    resolveInfo
                  );
                  const resolveData = getDataFromParsedResolveInfoFragment(
                    parsedResolveInfoFragment,
                    PayloadType
                  );
                  const modifiedRowAlias = sql.identifier(Symbol());
                  const query = queryFromResolveData(
                    modifiedRowAlias,
                    modifiedRowAlias,
                    resolveData,
                    {}
                  );
                  let queryWithMutation;
                  if (mode === "update") {
                    const sqlColumns = [];
                    const sqlValues = [];
                    const inputData =
                      input[
                        inflection.patchField(
                          inflection.tableName(table.name, table.namespace.name)
                        )
                      ];
                    introspectionResultsByKind.attribute
                      .filter(attr => attr.classId === table.id)
                      .forEach(attr => {
                        const fieldName = inflection.column(
                          attr.name,
                          table.name,
                          table.namespace.name
                        );
                        if (
                          fieldName in
                          inputData /* Because we care about null! */
                        ) {
                          const val = inputData[fieldName];
                          sqlColumns.push(sql.identifier(attr.name));
                          sqlValues.push(gql2pg(val, attr.type));
                        }
                      });
                    if (sqlColumns.length === 0) {
                      return null;
                    }
                    queryWithMutation = sql.query`
                          with ${modifiedRowAlias} as (
                            update ${sql.identifier(
                              table.namespace.name,
                              table.name
                            )} set ${sql.join(
                      sqlColumns.map(
                        (col, i) => sql.fragment`${col} = ${sqlValues[i]}`
                      ),
                      ", "
                    )}
                            where ${condition}
                            returning *
                          ) ${query}
                          `;
                  } else {
                    queryWithMutation = sql.query`
                      with ${modifiedRowAlias} as (
                        delete from ${sql.identifier(
                          table.namespace.name,
                          table.name
                        )}
                        where ${condition}
                        returning *
                      ) ${query}
                      `;
                  }
                  const { text, values } = sql.compile(queryWithMutation);
                  if (debugSql.enabled)
                    debugSql(require("sql-formatter").format(text));
                  const { rows: [row] } = await pgClient.query(text, values);
                  if (!row) {
                    throw new Error(
                      `No values were deleted in collection '${pluralize(
                        table.name
                      )}' because no values were found.`
                    );
                  }
                  return {
                    __clientMutationId: input.clientMutationId,
                    data: row,
                  };
                }

                // NodeId
                if (nodeIdFieldName) {
                  const primaryKeyConstraint = introspectionResultsByKind.constraint
                    .filter(con => con.classId === table.id)
                    .filter(con => ["p"].includes(con.type))[0];
                  if (!primaryKeyConstraint) {
                    return memo;
                  }
                  const primaryKeys =
                    primaryKeyConstraint &&
                    primaryKeyConstraint.keyAttributeNums.map(
                      num => attributes.filter(attr => attr.num === num)[0]
                    );
                  const fieldName = inflection[
                    mode === "update" ? "updateNode" : "deleteNode"
                  ](table.name, table.namespace.name);
                  const InputType = buildObjectWithHooks(
                    GraphQLInputObjectType,
                    {
                      name: inflection[
                        mode === "update"
                          ? "updateNodeInputType"
                          : "deleteNodeInputType"
                      ](table.name, table.namespace.name),
                      fields: Object.assign(
                        {
                          clientMutationId: {
                            type: GraphQLString,
                          },
                          [nodeIdFieldName]: {
                            type: new GraphQLNonNull(GraphQLID),
                          },
                        },
                        mode === "update" && {
                          [inflection.patchField(
                            inflection.tableName(
                              table.name,
                              table.namespace.name
                            )
                          )]: {
                            type: new GraphQLNonNull(TablePatch),
                          },
                        }
                      ),
                    },
                    {
                      isPgUpdateInputType: mode === "update",
                      isPgUpdateNodeInputType: mode === "update",
                      isPgDeleteInputType: mode === "delete",
                      isPgDeleteNodeInputType: mode === "delete",
                      pgInflection: table,
                    }
                  );

                  memo[
                    fieldName
                  ] = buildFieldWithHooks(
                    fieldName,
                    ({ getDataFromParsedResolveInfoFragment }) => {
                      return {
                        type: PayloadType,
                        args: {
                          input: {
                            type: new GraphQLNonNull(InputType),
                          },
                        },
                        async resolve(
                          parent,
                          { input },
                          { pgClient },
                          resolveInfo
                        ) {
                          const nodeId = input[nodeIdFieldName];
                          try {
                            const [alias, ...identifiers] = JSON.parse(
                              base64Decode(nodeId)
                            );
                            const NodeTypeByAlias = getNodeType(alias);
                            if (NodeTypeByAlias !== TableType) {
                              throw new Error("Mismatched type");
                            }
                            if (identifiers.length !== primaryKeys.length) {
                              throw new Error("Invalid ID");
                            }

                            return commonCodeRenameMe(
                              pgClient,
                              resolveInfo,
                              getDataFromParsedResolveInfoFragment,
                              PayloadType,
                              input,
                              sql.fragment`(${sql.join(
                                primaryKeys.map(
                                  (key, idx) =>
                                    sql.fragment`${sql.identifier(
                                      key.name
                                    )} = ${gql2pg(identifiers[idx], key.type)}`
                                ),
                                ") AND ("
                              )})`
                            );
                          } catch (e) {
                            debug(e);
                            return null;
                          }
                        },
                      };
                    }
                  );
                }

                // Unique
                uniqueConstraints.forEach(constraint => {
                  const keys = constraint.keyAttributeNums.map(
                    num => attributes.filter(attr => attr.num === num)[0]
                  );
                  if (!keys.every(_ => _)) {
                    throw new Error(
                      "Consistency error: could not find an attribute!"
                    );
                  }
                  const simpleKeys = keys.map(k => ({
                    column: k.name,
                    table: k.class.name,
                    schema: k.class.namespace.name,
                  }));
                  const fieldName = inflection[
                    mode === "update" ? "updateByKeys" : "deleteByKeys"
                  ](simpleKeys, table.name, table.namespace.name);
                  const InputType = buildObjectWithHooks(
                    GraphQLInputObjectType,
                    {
                      name: inflection[
                        mode === "update"
                          ? "updateByKeysInputType"
                          : "deleteByKeysInputType"
                      ](simpleKeys, table.name, table.namespace.name),
                      fields: Object.assign(
                        {
                          clientMutationId: {
                            type: GraphQLString,
                          },
                        },
                        mode === "update" && {
                          [inflection.patchField(
                            inflection.tableName(
                              table.name,
                              table.namespace.name
                            )
                          )]: {
                            type: new GraphQLNonNull(TablePatch),
                          },
                        },
                        keys.reduce((memo, key) => {
                          memo[
                            inflection.column(
                              key.name,
                              key.class.name,
                              key.class.namespace.name
                            )
                          ] = {
                            type: new GraphQLNonNull(
                              gqlInputTypeByTypeId[key.typeId]
                            ),
                          };
                          return memo;
                        }, {})
                      ),
                    },
                    {
                      isPgUpdateInputType: mode === "update",
                      isPgUpdateByKeysInputType: mode === "update",
                      isPgDeleteInputType: mode === "delete",
                      isPgDeleteByKeysInputType: mode === "delete",
                      pgInflection: table,
                      pgKeys: keys,
                    }
                  );

                  memo[
                    fieldName
                  ] = buildFieldWithHooks(
                    fieldName,
                    ({ getDataFromParsedResolveInfoFragment }) => {
                      return {
                        type: PayloadType,
                        args: {
                          input: {
                            type: new GraphQLNonNull(InputType),
                          },
                        },
                        async resolve(
                          parent,
                          { input },
                          { pgClient },
                          resolveInfo
                        ) {
                          return commonCodeRenameMe(
                            pgClient,
                            resolveInfo,
                            getDataFromParsedResolveInfoFragment,
                            PayloadType,
                            input,
                            sql.fragment`(${sql.join(
                              keys.map(
                                key =>
                                  sql.fragment`${sql.identifier(
                                    key.name
                                  )} = ${gql2pg(
                                    input[
                                      inflection.column(
                                        key.name,
                                        key.class.name,
                                        key.class.namespace.name
                                      )
                                    ],
                                    key.type
                                  )}`
                              ),
                              ") AND ("
                            )})`
                          );
                        },
                      };
                    }
                  );
                });
              }
              return memo;
            }, outerMemo),
          {}
        )
      );
    }
  );
};