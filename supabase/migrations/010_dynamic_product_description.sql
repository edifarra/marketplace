-- A descricao e derivada das configuracoes atuais ao exibir ou enviar o produto.
-- Nao deve existir uma copia desatualizada no cadastro do produto.
alter table products drop column if exists description;
