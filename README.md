# SAP Communication Migrator

SAP S/4HANA Public Cloud sistemleri arasında **Communication Users**, **Communication Systems** ve **Communication Arrangements** nesnelerini kopyalayan web uygulaması.

## Kullanım Bilgisi

Bu program standart API'ler ile kopyalama yapmaktadır. Bu yüzden nesnelerin kopyalanabilmesi için kaynak ve hedef sistem içerisinde **SAP_COM_0A48** arrangement ve buna bağlı olarak communication user ve communication system oluşturulmalıdır.

## Kullanılan API'ler

- [Communication User](https://api.sap.com/api/sap-s4-CE_APS_COM_CU_A4C_ODATA_0001-v1/overview)
- [Communication System](https://api.sap.com/api/sap-s4-CE_APS_COM_CS_A4C_ODATA_0001-v1/overview)
- [Communication Arrangement](https://api.sap.com/api/sap-s4-CE_APS_COM_CA_A4C_ODATA_0001-v1/overview)

## Kurulum

```bash
npm install
node server.js
```

Tarayıcıda `http://localhost:3000` adresini aç.

## Geliştirici

Ahmet Faruk KÖSEOĞLU
