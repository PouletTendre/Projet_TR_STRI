# Répartition hybride REST et AMQP 0-9-1

Le système combine des requêtes synchrones orientées ressources issues de clients hétérogènes (postes utilisateurs, routeurs matériels, logiciels) avec des traitements internes d'autorités de certification, de la diffusion temps réel d'événements de sécurité et une messagerie texte asynchrone. Nous retenons une architecture hybride : **REST (HTTP/JSON documenté en OpenAPI 3.0)** pour les façades synchrones (`AE`, `AV`, `Service de Publication`) et **AMQP 0-9-1** (3 échangeurs durables : `ex.pki.commandes` en `direct`, `ex.pki.publications` en `topic`, `ex.chat.messages` en `direct`) pour les échanges `AE ↔ AC`, la diffusion des certificats et LCR, ainsi que le transport de la messagerie texte.

## Considered Options

- **AMQP minimal (publications et chat uniquement, `AE ↔ AC` en REST)** : simplifie le couplage `AE ↔ AC`, mais oblige à exposer les AC en HTTP et prive le cœur d'émission de la mise en file résiliente face aux pics d'enrôlement.
- **Tout-AMQP sauf consultation (`Porteur ↔ AE` en AMQP)** : impose un client AMQP sur toutes les ressources hétérogènes (dont des équipements embarqués/routeurs) simplement pour soumettre une demande de certification.
- **Hybride REST (façades clients) + AMQP 0-9-1 (`AE ↔ AC`, publications, chat)** : exploite REST là où l'interopérabilité requête/réponse prime, et AMQP là où l'isolation, le routage par échangeur et l'asynchrone sont essentiels.

## Consequences

- Les **AC** n'exposent aucune interface HTTP directe ; elles consomment leurs commandes via `ex.pki.commandes` (`direct`) et répondent via `reply_to` / `correlation_id`.
- Le **Service de Publication** et les **AV** reçoivent en temps réel chaque nouveau certificat et chaque mise à jour de LCR via l'échangeur `topic` `ex.pki.publications` sans polling.
- La messagerie texte est isolée sur un échangeur dédié `ex.chat.messages` (`direct`) et des files `q.chat.inbox.<id_correspondant>`, cloisonnées côté bordure par la **Passerelle Edge Messagerie**.
