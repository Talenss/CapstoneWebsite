import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';

/** Port of the PHP 404.html */
@Component({
  selector: 'app-not-found',
  standalone: true,
  imports: [RouterLink, Header, Footer],
  templateUrl: './not-found.html',
})
export class NotFound {}
