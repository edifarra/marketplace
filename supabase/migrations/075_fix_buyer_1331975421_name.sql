update marketplace_conversations
set buyer_name = 'Adenia (LOGOS ELETRONICA)', updated_at = now()
where marketplace = 'mercado_livre'
  and buyer_id = '1331975421';

update marketplace_conversation_messages message
set sender_name = 'Adenia (LOGOS ELETRONICA)'
from marketplace_conversations conversation
where message.conversation_id = conversation.id
  and message.direction = 'incoming'
  and conversation.marketplace = 'mercado_livre'
  and conversation.buyer_id = '1331975421';
