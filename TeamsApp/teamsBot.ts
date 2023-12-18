import {
  TeamsActivityHandler,
  CardFactory,
  TurnContext,
  AdaptiveCardInvokeValue,
  AdaptiveCardInvokeResponse,
} from "botbuilder";
import { OpenAIClient, AzureKeyCredential, GetChatCompletionsOptions } from "@azure/openai";
import fs from 'fs';
import axios, { AxiosResponse } from 'axios';

export class TeamsBot extends TeamsActivityHandler {
  private endpoint: string;
  private azureApiKey: string;
  private pythonapiUrl: string;

  constructor(  ) {
    super();
    this.endpoint = process.env["AZURE_OPENAI_ENDPOINT"];
    this.azureApiKey = process.env["AZURE_OPENAI_API_KEY"];
    this.pythonapiUrl = process.env["PYTHONAPI"];

    this.onMessage(async (context, next) => {

      const intent = await this.getIntent(context);
      switch (intent.type.toLowerCase()) {
        case 'describe':
          await this.GenerateAreaDescription(context, this.endpoint, this.azureApiKey);
          break;
        case 'code':
          await this.GenerateCodedAnswer(context, this.endpoint, this.azureApiKey);
          break;
        default:
          await context.sendActivity(`I'm sorry, I don't know how to ${intent.type}.`);
          break;
      }
      await next();
    });

    this.onMembersAdded(async (context, next) => {
      const membersAdded = context.activity.membersAdded;
      for (let cnt = 0; cnt < membersAdded.length; cnt++) {
        if (membersAdded[cnt].id) {
          await context.sendActivity(
            `Hi there! I'm Building Copilot that will help you managing your building. `
          );
          break;
        }
      }
      await next();
    });
  }

  async getIntent(context: TurnContext): Promise<any> {
    const prompt = this.genIntentPrompt(context.activity.text);
    const messages = [
      { role: "system", content: "You are a JSON generator. You only return JSON code." },
      { role: "user", content: `${prompt}` },
    ];

    const intent = await this.ExecOpenAIPrompt(this.endpoint, this.azureApiKey, messages);
    return JSON.parse(intent);
  }

  async GenerateCodedAnswer(context: TurnContext, endpoint: string, azureApiKey: string) {
    try {
      let genCodePrompt = this.genCodePrompt(context.activity.text);

      const messages = [
        { role: "system", content: "You are a Python code generator. You only return Python code." },
        { role: "user", content: `${genCodePrompt}` },
      ];

      let result:any;
      const nrRetry = 3;
      for (let i = 0; i < nrRetry; i++) {
        const generatedcode = await this.ExecOpenAIPrompt(endpoint, azureApiKey, messages);

        const pyhton = JSON.parse(generatedcode);
        context.sendActivity(`Generated code:\n\`\`\` python \n ${pyhton.code} \n \`\`\` `);

        await this.showTypingIndicator(context);
        const execCodeUrl = `${this.pythonapiUrl}/execute`;
        let response: AxiosResponse<any, any>;
        try {
          response = await axios.post(execCodeUrl, generatedcode, { headers: { 'Content-Type': 'application/json' }});
          console.log(response.data.result);
          result = response.data.result;
          break;
        } catch (error) {
          await context.sendActivity(`Run ${i}. Could not perform the operation. Please try again with other phrase. `);
          if (i == nrRetry)
            return;
        }
        //await context.sendActivity(response.data.result);
      }

      const messages2 = [
        { role: "system", content: "You are a JSON generator for Adaptive Cards." },
        { role: "user", content: JSON.stringify(this.genAdaptiveCardPrompt(result))  },
      ];

      console.log(messages2);
      for (let i=0; i < nrRetry; i++) {
        await this.showTypingIndicator(context);
        const msg2 = await this.ExecOpenAIPrompt(endpoint, azureApiKey, messages2);
        console.log(msg2);

        // retrieve the JSON from the response, and send it as an Adaptive Card
        const matched = msg2.match(/{[\s\S]*}/);
        const content = matched ? matched[0] : '';
        if (matched) {
          //console.log(content);
          //await context.sendActivity(content);
          try {
          const cardPayload = JSON.parse(content);
          await context.sendActivity({ attachments: [ { contentType: "application/vnd.microsoft.card.adaptive", content: cardPayload } ] });
          break;
          } catch (error) {
            if (i == nrRetry) { 
              await context.sendActivity(`Could not parse the generated adaptive card. Please try again with other phrase.`);
              console.error(error);
            } else {
              await context.sendActivity(`Retry generating adaptive card ${i}.`);
            }
          }
        } else {
          await context.sendActivity(`Could not perform the operation. Please try again with other phrase. ${msg2}`);
        }
      }

    } catch (error) {
      context.sendActivity(`Could not perform the operation. Please try again with other phrase. ${error.message}`);
    }
  }

  private async GenerateAreaDescription(context: TurnContext, endpoint: string, azureApiKey: string) {
    await this.showTypingIndicator(context);

    //Get areaId  from input
    const mentionRegex = /<at>.*?<\/at>/g;
    const text = context.activity.text.replace(mentionRegex, '');
    const matched = text.match(/\d+/);
    const area_id = matched ? Number(matched[0]) : null;
    const execCodeUrl = `${this.pythonapiUrl}/area/${area_id}`;
    let response: AxiosResponse<any, any>;
    try {
      response = await axios.get(execCodeUrl, { headers: { 'Content-Type': 'application/json' } });
      console.log(response.data);
      const areaData = response.data;
      const messages = [
        { role: "system", content: "You are a funny tweet generator." },
        { role: "user", content: `${this.genDescribePrompt(areaData)}` },
      ];
      const msg = await this.ExecOpenAIPrompt(endpoint, azureApiKey, messages);
      await context.sendActivity(msg);
    } catch (error) {
      await context.sendActivity(`Could not perform the operation. Please try again with other phrase. `);
    }
  }

  private async ExecOpenAIPrompt(endpoint: string, azureApiKey: string, messages: { role: string; content: string; }[]) {
    const client = new OpenAIClient(endpoint, new AzureKeyCredential(azureApiKey));
    const deploymentId = "gpt-35-turbo";
    const options: GetChatCompletionsOptions = {
      temperature: 0.4,
    }
    const result = await client.getChatCompletions(deploymentId, messages, options);
    const msg = result.choices[0].message.content;
    return msg;
  }

  private genCodePrompt(query: string) {
    const filePath = 'prompt/building/prompt.txt';
    let prompt = '';

    try {
      prompt = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(err);
      return '';
    }
    return prompt.replace('{{INPUT}}', query);;
  }

  private genAdaptiveCardPrompt(json: string) {
    const filePath = 'prompt/adaptiveCard/prompt.txt';
    let prompt = '';

    try {
      prompt = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(err);
    }
    return prompt + json;
  }

  private genDescribePrompt(area: string) {
    const filePath = 'prompt/describe/prompt.txt';
    let prompt = '';

    try {
      prompt = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(err);
    }
    return prompt + area;
  }

  private genIntentPrompt(message: string) {
    const filePath = 'prompt/intent/prompt.txt';
    let prompt = '';

    try {
      prompt = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(err);
    }
    return prompt + message;
  }

  async showTypingIndicator(context: TurnContext): Promise<void> {
    const typingActivity = {
      type: 'typing',
      relatesTo: context.activity.relatesTo,
    };

    await context.sendActivity(typingActivity);
  }
}
