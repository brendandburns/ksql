# KSQL - A simple tool for interactive database queries on Kubernetes resources.

## Prerequisites:
```
npm install q
npm install alasql
npm install node-kubernetes-client
npm install readline-history
npm install cli-table2
npm install js-yaml
```

## Running:
```
kubectl proxy &
node ksql.js
```
## Running via Docker:
```
docker build -t ksql
docker run --rm -ti -v ${HOME}/.kube:/root/.kube:ro ksql
```

## Example Queries:
```sql
select count(*) from containers where containers.image like 'mysql%'
```


```sql
select count(*),image from containers where containers.image like 'mysql%' group by image
```

```sql
select pods.metadata->name,pods.metadata->annotations->email,image from pods join containers using uid where image like 'mysql:5.5%'
```

```sql
select pods.metadata->name,image from pods left join containers using uid where image like 'mysql%' and not pods.metadata->annotations->email
```
