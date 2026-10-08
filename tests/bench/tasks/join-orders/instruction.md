`/app/customers.csv` (`customer_id,country`) and `/app/orders.csv` (`order_id,customer_id,amount`) come from two systems. Some orders name a customer the customers file does not have.

Write `/app/by_country.csv` with the header `country,orders,amount` and one row per country (sorted by country code): the number of orders and their total amount rounded to 2 decimals. Then write to `/app/unmatched.txt` the number of orders whose customer is unknown.
