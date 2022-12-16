import fs from 'fs';
import path from 'path';

import axios from 'axios';
import { PDFDocument } from 'pdf-lib';
import _ from 'underscore';

import db from '../db';
import sendEmail from '../send-email';
import conditionService from "../conditions/condition.service";

async function getProcessByName(name: any) {
  const process = await db.Design.findOne({ name });
  if (process) {
    return process;
  }
  return false;
}
async function updateRecord(
    step: {
      label: string,
      name: string,
      type: string,
      object: string,
      meta: {
        conditions: any,
        fields: {
          text: string,
          value: string,
        }[],
        variable: {
          text: string
          value: {
            name: string,
            object: string,
          }
        },
      }
    },
    pool: any,
) {
  const variable = pool[step.meta.variable.value.name];
  // find and update
  const record = await db.Record.findOne({ _id: variable._id });
  if (record) {
    _.each(step.meta.fields, field => {
      record.data[field.text] = field.value;
    })
    try {
      return db.Record.updateOne({ _id: record._id.toString() }, record);
    } catch (e) {
      console.log(e);
    }
  }
  return false;
}

async function runFindRecordStep(
    step: {
      object: string,
      meta: {
        conditions: {
          statements: {
            lhs: any; operator: any; rhs: any
          }[];
        };
      };
    },
    pool: any,
) {
  const record = conditionService.runCondition(step.meta.conditions, pool)

  if (record) {
    return record;
  }
  return false;
}
async function runIfStep(
    step: {
      object: string,
      meta: {
        steps: any[],
        conditions: {
          statements: { lhs: any; operator: any; rhs: any }[]
        };
      };
    },
    pool: any,
) {
  const evaluation = await conditionService.runCondition(step.meta.conditions, pool)
  let evaluatedIfStep: any[] = [];
  if (evaluation) {
    evaluatedIfStep = await runProcess({ meta: { steps: step.meta.steps }  }, pool);
  }
  if (evaluatedIfStep.length > 0) {
    return evaluatedIfStep;
  }
  return pool;
}

async function runCreatePdf(
  step: { meta: { object: any; template: any; fields: any } },
  pool: any
) {
  // determine step object

  const {
    object: stepObject,
    template: stepTemplate,
    fields: stepFields,
  } = step.meta;

  const { value: varName } = stepObject;
  const { path: fileName } = stepTemplate;

  // get the pdf form
  const templatePath = path.join('.', 'files', fileName);

  const existingPdfBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(existingPdfBytes);

  const form = pdfDoc.getForm();

  // get the varName from pool
  let variable: { data: { [x: string]: string | undefined } };
  _.each(pool, (item) => {
    if (item.name === varName) {
      variable = item;
    }
  });
  // @ts-ignore
  if (!variable) return false;
  _.each(Object.keys(stepFields), (fieldName) => {
    if (stepFields[fieldName]) {
      const field = form.getTextField(fieldName);
      try {
        field.setText(variable.data[fieldName]);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log('e: ', e);
      }
    }
  });

  form.flatten();

  const now = Date.now();

  fs.writeFileSync(
    path.join('.', 'files', `${now}_${varName}.pdf`),
    await pdfDoc.save()
  );

  return { file: `${now}_${varName}.pdf` };
}

async function runEmailStep(
  step: {
    meta: {
      email: { to: { type?: any; value?: any }; subject: any; message: string };
    };
  },
  pool: any
) {
  let subject;
  let to;
  let message = '';
  const { value } = step.meta.email.to;
  if (step.meta.email.to.type === 'variable') {
    // @ts-ignore
    to = pool[value.variable.name.value.name].data[value.field];
  } else {
    // if it is a literal
    to = value.literal;
  }

  if (step.meta.email.subject) {
    subject = step.meta.email.subject;
  }

  if (step.meta.email.message) {
    message = step.meta.email.message;
  }
  const html = `<p> ${message},</p>`;
  try{
    await sendEmail({
      to,
      subject,
      html,
      from: undefined,
    });
    return true;
  } catch(e) {
    return false;
  }
}

async function runApiStep(
  step: {
    meta: {
      api: { body: any; type?: any; url?: any };
      headers: string | any[];
    };
  },
  pool: any[]
) {
  const { url } = step.meta.api;
  const apiType = step.meta.api.type;
  const apiData = step.meta.api;
  const headers = {};
  for (let i = 0; i < step.meta.headers.length; i++) {
    if (step.meta.headers[i].type === 'literal') {
      // @ts-ignore
      headers[step.meta.headers[i].key] = step.meta.headers[i].value;
    }
  }

  const body = {};
  // @ts-ignore
  for (let i = 0; i < apiData.body.length; i++) {
    if (apiData.body[i].type === 'literal') {
      // @ts-ignore
      body[apiData.body[i].key] = apiData.body[i].value;
    }
  }

  if (apiType === 'Get') {
    const res = await axios({
      method: 'get',
      url,
      headers,
      data: body,
    });
    if (res.status === 200) {
      return res.data;
    }
  } else if (apiType === 'Post') {
    const res = await axios({
      method: 'post',
      url,
      headers,
      data: body,
    });
    if (res.status === 200) {
      return res.data;
    }
  }
  return false;
}

async function runProcess(
  process: { meta: { steps: string | any[] } },
  pool: any,
) {
  // convert pool to map
  let poolMap = pool
  if (_.isArray(pool)) {
    poolMap =_.object(_.map(pool, (x) => ([x.name, x])));
  }
  let result;
  for (let i = 0; i < process.meta.steps.length; i++) {
    const step = process.meta.steps[i];
    if (step.type === 'find_record') {
      console.log('------------------Find Record------------------');
      poolMap[step.name] = await runFindRecordStep(step, poolMap);
    } else if (step.type === 'send_email') {
      console.log('------------------Send Email------------------');
      poolMap[step.name] = await runEmailStep(step, poolMap);
    } else if (step.type === 'api_call') {
      console.log('------------------Api Call------------------');
      result = await runApiStep(step, poolMap);
    } else if (step.type === 'if') {
      console.log('------------------If Step------------------');
      result = await runIfStep(step, poolMap);
    } else if (step.type === 'create_pdf') {
      console.log('------------------Create Pdf------------------');
      result = await runCreatePdf(step, poolMap);
    } else if (step.type === 'update_record') {
      console.log('------------------Update Record------------------');
      poolMap[step.name] = await updateRecord(step, poolMap);
    }
  }
  return result || true;
}

export default {
  runProcess,
  getProcessByName,
};
