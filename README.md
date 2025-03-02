# Graffiticode

*Graffiticode* is a framework for developing and deploying task oriented web APIs. In *Graffiticode*, apis implement task specific languages and requests include code to execute tasks in those languages.

## The Big Idea

The big idea of *Graffiticode* (*Gc*) is to expose the domain model of a web api as a language and hide the implementation complexity behind that language.

Every api is defined as a task specific language, much in the same way that *GraphQL* (*GQL*) apis are defined by the *GQL* query language. The main difference between *Gc* and *GQL* is that each *Gc* api has a unique domain specific language whereas all *GQL* apis share one general query language. The thing *Gc* and *GQL* have in common is that each request is defined by a block of code.

*Graffiticode* enables deeper communication and collaboration by giving a shared language to the users, designers and developers of the api. All stakeholders are able to participate deeply in the development process by collaborating in code.

## Core Components

<img src="https://github.com/graffiticode/graffiticode/assets/334236/78a3761f-15fc-40ea-9bbc-c77e782df78d" width=500 />

*Gc* is built on a small set of components. These include:
* Languages
* API
* Client

## Languages

*Gc* languages have a shared syntax and a unique vocabulary as defined by a language specific *lexicon*. They are implemented by a back-end *compiler* and front-end *form*.

It would not be too far fetched to think of each language as implementing a micro-MVC where the compiler is the *Controller* that produces data that is the *Model* which is rendered by the form that is the *View*.

<img src="https://github.com/graffiticode/graffiticode/assets/334236/8443affc-ad12-481e-b2b2-350c99d281af" width=400 />

## API

The *Gc* API performs the following core functions:
* Storing tasks
* Compiling tasks
* Authenticating requests

In *Gc*, a unit of compilation is a *task*. A task is composed of a language identifier and a code block.

```
let task = { lang, code }
```

### Storing tasks

When a task is posted to the API, it is hashed to a unique `id` and stored with that `id` as its key.

```
POST /task { lang, code } => { id }
```

The response value contains the `id`.

Multiple tasks can be posted resulting in an array of `ids` being returned.

```
POST /tasks [{ lang, code }, ...] => { id: [id, ...] }
```

### Composing task pipelines

Tasks can be chained together so that the result of compiling the head of a pipeline is passed to the rest of that pipeline (the tail.)

A task pipeline is encoded as a sequence of task ids concatenated together with `+` as the separator. A task pipeline is compiled from right to left with the data resulting from each compile being passed to the next task in the pipeline.

In the following example, the task associated with `id2` is compiled with the empty object as its `data`, and the resulting value is passes as `data` to the compile of task `id1`, and so on.

```
let taskID = "id0+id1+id2"
```

The ultimate head of every task pipeline is often the dynamic state of the client form. When this is the case, a kind of MVC pattern mentioned above is formed.

Imagine, for example, a language for writing charts. The form that renders the charts also has a table for entering the data to be graphed. When the data is changed, it is sent to the compiler to generate a new chart model to be rendered by the form.

### Compiling tasks

With a `taskID` in hand, the client may compile that task. There are two `Gc` API calls that cause a task to be compiled:

```
GET /data?id=<taskID>
```
and
```
POST /compile { id: taskID, data }
```

#### API GET /data
`GET /data` maps a taskID to data. The *task* referenced by `id` is retrieved and the code of that task is sent to the task's language compiler along with the data of the previous task in the pipeline, if any.

Once compiled, the mapping from taskID to data is guaranteed to never change. Calls to `Gc` compilers are idempotent so the result of a compile can be safely cached.

#### API POST /compile

`POST /compile { id, data }` is a helper function that creates a task from the `data` argument, concatenates the resulting `taskID` to `id`, and compiles the resulting task pipeline using the handler of `GET /data`.

#### Ln POST /compile

The API delegates the compiling of a task to the corresponding language, passing the task's `code` and the `data` from the previous task in the data pipeline, or the empty object when compiling the ultimate head task.

```
POST /compile { code, data }
```

The response value has a `status` field, and either an `error` or a `data` field corresponding to the value of the `status` field (ie `"error"` or `"success"`).

### Authenticating requests

Requests to the API must includes an authentication token in the header `authorization` field. This token can be acquired in exchange for a valid API key generated found in the console *Settings* page.

## Client

A *client* is any software that calls the APIs various endpoints. The Graffiticode console is one such client. Any code, whether running in a browser or server, can call the API as long as it as a valid authentication token.

Each language provides a *Form* view that renders the output of compiles. Clients can embed these form views to render its view, or create a different view of the data.

The common usage of the client view of a language is to pass relevant updates to the view state to the compiler via a `POST /compile { id, data }` call, where `data` is some representation of the new state.

## Running Graffiticode Locally

```shell
git clone git@github.com:graffiticode/graffiticode.git
cd graffiticode
npm install
```

### Firebase emulators

```shell
npx firebase emulators:start
```

### Auth

```shell
npm run -w packages/auth dev
```

### API

```shell
npm run -w packages/api dev
```

### L0002

*L0002* is a starter language that is useful for writing a 'hello, world!' web API or developing a new language.

```shell
git clone git@github.com:graffiticode/l0002.git
cd l0002
npm install
npm run dev
```

### Console

```shell
git clone git@github.com:graffiticode/console.git
cd console
npm install
npm run dev
```

### Try It

Navigate to `localhost:3000` in a browser and sign-in. You'll need an
Ethereum wallet extention installed to sign-in. Metamask or Coinbase will do.

Congratulations! You are now ready to:
* Read language specs
* Create tasks
* Review compiles
* Generate API keys
* Make API calls
* Develop new languages
* Build a better web
