import { GeneratorOptions } from '@prisma/generator-helper';
import * as path from 'path';
import * as child_process from 'child_process';
import fs from 'fs';
import os from 'os';
import YAML from 'yaml';
import { format } from 'prettier';

export interface DMLModel {
    name: string;
    isEmbedded: boolean;
    dbName: string | null;
    fields: {
        name: string;
        hasDefaultValue: boolean;
        isGenerated: boolean;
        isId: boolean;
        isList: boolean;
        isReadOnly: boolean;
        isRequired: boolean;
        isUnique: boolean;
        isUpdatedAt: boolean;
        kind: 'scalar' | 'object' | 'enum';
        type: string;
        relationFromFields?: any[];
        relationName?: string;
        relationOnDelete?: string;
        relationToFields?: any[];
    }[];
    idFields: any[];
    uniqueFields: any[];
    uniqueIndexes: any[];
    isGenerated: boolean;
}
export interface DML {
    enums: any[];
    models: DMLModel[];
}

function getDataModelFieldWithoutParsing(parsed: string) {
    const startOfField = parsed.indexOf('"datamodel"');
    const openingBracket = parsed.indexOf('{', startOfField);

    let numberOfOpeningBrackets = 0;
    let closingBracket = openingBracket;
    while (closingBracket < parsed.length) {
        const char = parsed[closingBracket++];

        if (char === '{') {
            numberOfOpeningBrackets++;
        } else if (char === '}') {
            numberOfOpeningBrackets--;

            if (numberOfOpeningBrackets === 0) {
                break;
            }
        }
    }

    return parsed.slice(openingBracket, closingBracket);
}

interface ParseEnumValue {
    name: string;
    dbName?: string;
}
interface ParsedEnums {
    name: string;
    values: ParseEnumValue[];
    dbName?: string;
}

interface ParsedModel {
    name: string;
    dbName?: string;
    fields: ModelField[];
    isGenerated: boolean;
    primaryKey?: string;
    uniqueFields?: string[];
    uniqueIndexes?: string[];
}

interface feildDefault {
    name: defaultEnum;
    args?: string[];
}

type defaultEnum = 'autoincrement' | 'uuid' | string;
type prismaDefault = feildDefault | any;
type dbType = 'Int' | 'String' | 'DateTime' | 'Json';
type SwaggerType = 'string' | 'int' | 'number' | 'object';
const swaggerTypeArray = ['string', 'int', 'number'];
interface ModelField {
    name: string;
    kind: 'scalar' | 'object' | 'enum';
    isList: boolean;
    isRequired: boolean;
    isUnique: boolean;
    isId: boolean;
    isReadOnly: boolean;
    type: dbType;
    hasDefaultValue: boolean;
    default: feildDefault;
    isGenerated: boolean;
    isUpdatedAt: boolean;
}

interface SwaggerField {
    type?: SwaggerType;
    enum?: string[];
    format?: string;
    nullable?: boolean;
    default?: string;
    $ref?: string;
}

interface SwaggerModel {
    [key: string]: SwaggerField;
}

export async function parseDatamodel(
    engine: string,
    model: string,
    tmpDir: string
) {
    const tmpSchema = path.resolve(path.join(tmpDir, 'schema.prisma'));

    fs.writeFileSync(tmpSchema, model);

    const parsed: string = await new Promise((resolve, reject) => {
        const process = child_process.exec(
            `${engine} --datamodel-path=${tmpSchema} cli dmmf`
        );
        let output = '';
        process.stderr?.on('data', (l) => {
            if (l.includes('error:')) {
                reject(l.slice(l.indexOf('error:'), l.indexOf('\\n')));
            }
        });
        process.stdout?.on('data', (d) => (output += d));
        process.on('exit', () => {
            resolve(output);
        });
    });

    return getDataModelFieldWithoutParsing(parsed);
}

function renderDml(dml: DML) {
    const diagram = 'erDiagram';

    const classes = dml.models
        .map(
            (model) =>
                `  ${model.dbName || model.name} {
  ${model.fields
      .filter(
          (field) =>
              field.kind !== 'object' &&
              !model.fields.find(
                  ({ relationFromFields }) =>
                      relationFromFields &&
                      relationFromFields.includes(field.name)
              )
      )
      .map((field) => `    ${field.type} ${field.name}`)
      .join('\n')}
    }
  `
        )
        .join('\n\n');

    let relationships = '';
    for (const model of dml.models) {
        for (const field of model.fields) {
            const relationshipName = field.name;
            const thisSide = model.dbName || model.name;
            const otherSide = field.type;
            if (
                field.relationFromFields &&
                field.relationFromFields.length > 0
            ) {
                let thisSideMultiplicity = '||';
                if (field.isList) {
                    thisSideMultiplicity = '}o';
                } else if (!field.isRequired) {
                    thisSideMultiplicity = '|o';
                }
                const otherModel = dml.models.find(
                    (model) => model.name === otherSide
                );
                const otherField = otherModel?.fields.find(
                    ({ relationName }) => relationName === field.relationName
                );

                let otherSideMultiplicity = '||';
                if (otherField?.isList) {
                    thisSideMultiplicity = 'o{';
                } else if (!otherField?.isRequired) {
                    thisSideMultiplicity = 'o|';
                }

                relationships += `    ${thisSide} ${thisSideMultiplicity}--${otherSideMultiplicity} ${
                    otherModel?.dbName || otherSide
                } : "${relationshipName}"\n`;
            }
            // many to many
            else if (
                dml.models.find(
                    (m) => m.name === field.type || m.dbName === field.type
                ) &&
                field.relationFromFields?.length === 0 &&
                field.relationToFields?.length
            ) {
                relationships += `    ${thisSide} o{--}o ${otherSide} : ""\n`;
            }
        }
    }

    return diagram + '\n' + classes + '\n' + relationships;
}

export const mapPrismaToDb = (dmlModels: DMLModel[], dataModel: string) => {
    const splitDataModel = dataModel
        ?.split('\n')
        .filter((line) => line.includes('@map'))
        .map((line) => line.trim());

    return dmlModels.map((model) => {
        return {
            ...model,
            fields: model.fields.map((field) => {
                // get line with field to \n
                const lineInDataModel = splitDataModel.find((line) =>
                    line.includes(`${field.name}`)
                );
                if (lineInDataModel) {
                    const startingMapIndex =
                        lineInDataModel.indexOf('@map') + 6;
                    const modelField = lineInDataModel.substring(
                        startingMapIndex,
                        lineInDataModel
                            .substring(startingMapIndex)
                            .indexOf('")') + startingMapIndex
                    );
                    if (modelField) {
                        field = { ...field, name: modelField };
                    }
                }

                return field;
            }),
        };
    });
};

export default async (options: GeneratorOptions) => {
    // try {
    const output = options.generator.output?.value || './prisma/ERD.svg';
    const config = options.generator.config;
    const theme = config.theme || 'forest';

    if (!options.binaryPaths?.queryEngine)
        throw new Error('no query engine found');

    const queryEngine =
        options.binaryPaths?.queryEngine[
            Object.keys(options.binaryPaths?.queryEngine)[0]
        ];

    const tmpDir = fs.mkdtempSync(os.tmpdir() + path.sep + 'prisma-erd-');

    // https://github.com/notiz-dev/prisma-dbml-generator
    const datamodelString = await parseDatamodel(
        queryEngine,
        options.datamodel,
        tmpDir
    );
    if (!datamodelString) throw new Error('could not parse datamodel');

    fs.writeFileSync('./prisma/ssssss.txt', datamodelString);

    const json = {};

    const parsedData = JSON.parse(datamodelString);
    const parsedEnum: ParsedEnums[] = parsedData.enums;
    const parsedModel: ParsedModel[] = parsedData.models;

    const swaggedEnum: SwaggerModel = {};
    parsedEnum.forEach((e: ParsedEnums) => {
        swaggedEnum[e.name] = {
            type: 'string',
            enum: e.values.map((e) => e.name),
            nullable: false,
            // default : e.
        };
    });
    const swaggedModel: any = {};
    parsedModel.forEach((e: ParsedModel): any => {
        var obj: any = {};
        e.fields.forEach((e: ModelField) => {
            obj[e.name as string] = {
                type: swaggerTypeArray.includes(e.type.toLowerCase())
                    ? e.type.toLowerCase()
                    : e.type == 'DateTime'
                    ? 'string'
                    : e.type === 'Json'
                    ? 'object'
                    : undefined,
                $ref:
                    e.kind === 'enum'
                        ? `#/components/schemas/${e.type}`
                        : e.kind === 'object'
                        ? `#/components/schemas/${e.type}`
                        : undefined,
                format: e.type == 'DateTime' ? 'date-time' : undefined,
                nullable: e.isRequired,
            };
        });
        swaggedModel[e.name] = {
            type: 'object',
            properties: {
                ...obj,
            },
        };
    });

    const dd = swaggedModel as SwaggerModel;
    const kim = Object.keys(dd).flatMap((e: string): any => ({
        [e]: {
            name: e,
            in: 'query',
            description: '',
            required: false,
            schema: {
                type: dd[e].type,
                format: dd[e].format,
            },
        },
    }));

    fs.writeFileSync(
        './prisma/paratest.json',
        JSON.stringify({
            kim,
        })
    );
    buildSwaggerDocs({
        enum: swaggedEnum,
        swaggedModel: swaggedModel,
    });
};
function buildSwaggerDocs(arg0: { enum: any; swaggedModel: any }) {
    fs.writeFileSync(
        './prisma/result.json',
        JSON.stringify({
            components: {
                schemas: {
                    ...arg0.swaggedModel,
                    ...arg0.enum,
                },
            },
        })
    );

    const doc = new YAML.Document();

    doc.contents = JSON.parse(
        JSON.stringify({
            components: {
                schemas: {
                    ...arg0.swaggedModel,
                    ...arg0.enum,
                },
            },
        })
    );

    const parameterDocs = new YAML.Document();

    fs.writeFileSync('./prisma/result.yaml', doc.toString());
    fs.writeFileSync('./prisma/parameters.yaml', doc.toString());
}
