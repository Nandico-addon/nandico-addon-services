# Ramsnehi Hospital

PACS group **48991** uses the shared MsgClub/iCloudSMS connector for WhatsApp.
This folder contains Ramsnehi's configuration and clinical messaging choices.

| File | Responsibility |
| --- | --- |
| `index.js` | Register the center and validate its environment |
| `config.js` | Group, provider and credential variable references |
| `workflow.js` | Choose the template for each event, recipient and report state |
| `whatsapp-templates.js` | Approved template names, languages and parameter order |

Common message preparation lives in
`src/shared/services/whatsapp-template.service.js`; reusable MsgClub HTTP code
lives in `src/shared/integrations/whatsapp/msgclub/provider.js`.

## Tests and reference

- [Routing and template catalog](../../../docs/msgclub-group-48991.md)
- [Provider and template tests](../../../test/centers/ramsnehi/provider.test.js)
- [Signed-event simulation tests](../../../test/centers/ramsnehi/simulation.test.js)
- [Postman provider collection](../../../examples/msgclub.postman_collection.json)
- [Local receiver collection](../../../examples/local.postman_collection.json)
- [Provider simulation](../../../postman/simulations/msgclub.sim.yaml)

Run `npm test` and `npm run test:msgclub` from the repository root. The simulation
uses fake provider credentials and synthetic events without live WhatsApp sends.
